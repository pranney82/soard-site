/**
 * test-room-credits.mjs — Admin → Kids → Designed by and Monetary sponsor, in a real browser
 * ==========================================================================================
 * Who designed a room and who paid for it (functions/api/_room-credits.js): one card each,
 * the same component. The admin is loaded from an Astro dev server with every /api/* call
 * answered from in-memory copies of src/content/kids and src/content/partners, and
 * /api/room-credits-admin answered as the real one answers (a credit changed at once, in
 * JobTread too when the kid has a job; the page's new version handed back). Save checks the
 * page version, so a card action that left the editor behind would show as a conflict.
 * Checks, at 1440px and 390px:
 *   - both cards in the side panel after Status; the sponsor card asks while awaiting funding
 *   - launch's question (JobTread named a sponsor this page didn't have): Use JobTread's
 *   - picking a design partner by keyboard: JobTread's Designed By too, their logo on the page,
 *     the toast says so; Save still works (no conflict)
 *   - Undo of that pick: the credit off, and them off the makeover (it put them on)
 *   - a name in JobTread that isn't a company: Same as… Link, and Not a company
 *   - credited but not on the makeover: Add them back, then Save puts them on the job
 *   - taking a credit off: the credit only; contacts and pledges for the sponsor
 *   - a kid with no JobTread job; phone: no sideways scroll, 44px targets; axe on both cards
 *   - Partners → JobTread access: the open credit questions counted on its tile and listed with whose
 *     page they're on, the last run's problem said; Not a company, Same as, Use JobTread's from there
 * Screenshots land in test-results/room-credits/. Exits non-zero on any failure.
 *
 *   SITE=http://localhost:4321 node scripts/test-room-credits.mjs
 * Without SITE it starts `astro dev` on a spare port and stops it after.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerAsks } from './lib/ask.mjs';
import { axeScan, axeText } from './lib/axe.mjs';
import { cleanPeople } from '../functions/api/_sponsors.js';
import { sameCompany } from '../functions/api/_room-credits.js';
import { nameKey } from '../public/admin/partners-shared.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/room-credits/');
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
const PROJECTS0 = readDir('community');
for (const [slug, d] of Object.entries(PROJECTS0)) { d.slug ||= slug; d.sponsors = []; d.designers = []; }
for (const [slug, d] of Object.entries(KIDS0)) { d.slug ||= slug; d.sponsors = []; d.designers = []; }
const PNG = join(OUT, 'pixel.png');
writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'));

const KID = Object.values(KIDS0).find((k) => k.status === 'needs-funding');
const NOJOB = Object.values(KIDS0).find((k) => k.status === 'completed' && k.slug !== KID?.slug && Number(k.year) < 2020);
const VOILA = PARTNERS0['the-voila-foundation'];
const CROSBY = PARTNERS0['crosby-design-group'];
if (!KID || !NOJOB || !VOILA || !CROSBY) { console.log('Needs an awaiting-funding kid, an older finished kid, The Voila Foundation and Crosby Design Group in src/content'); process.exit(1); }
const JOB = '22PJOBCREDT1';
const FIELD = { designed: 'Designed By', sponsored: 'Monetary Sponsor' };
const RECORD = { designed: 'designers', sponsored: 'sponsors' };

function makeApi() {
  const st = {
    kids: structuredClone(KIDS0), partners: structuredClone(PARTNERS0), projects: structuredClone(PROJECTS0), contacts: {}, calls: [], pledges: {}, versions: {}, shas: {},
    // JobTread's two fields on the kid's job, and what launch held for a person
    job: { designed: [], sponsored: ['The Voila Foundation', 'SOARF', 'Carlos Fund'] },
    held: { sponsored: { jobtread: ['the-voila-foundation'], website: [] } },
    notCompanies: [], links: {}, onJob: new Set(),
    last: null,
  };
  const shaOf = (slug) => (st.shas[slug] ||= `sha-${slug}-0`);
  const bump = (slug) => { st.shas[slug] = `sha-${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; return st.shas[slug]; };
  // As the real one reads names: Partners' name (word order aside), then a Same as link
  const partnerBy = (v) => Object.values(st.partners).find((p) => sameCompany(p.name, v)) || (st.links[v] && st.partners[st.links[v]]) || null;
  const logoOn = (kid, p) => (kid.partnerLogos || []).some((l) => l.url === p.logo || (l.name || '').toLowerCase() === p.name.toLowerCase());
  const recOf = (record) => (String(record).startsWith('community/') ? st.projects[record.slice(10)] : st.kids[record]);
  const room = (slug) => {
    const kid = recOf(slug);
    const hasJob = slug === KID.slug;
    const kinds = {};
    for (const kind of ['designed', 'sponsored']) {
      const held = hasJob ? st.held[kind] || null : null;
      kinds[kind] = {
        credits: (kid[RECORD[kind]] || []).map((s) => ({ slug: s, name: st.partners[s]?.name || s, gone: !st.partners[s], onRoom: !!st.partners[s] && (logoOn(kid, st.partners[s]) || st.onJob.has(s)) })),
        job: hasJob ? JOB : null,
        unknown: hasJob ? st.job[kind].filter((v) => !partnerBy(v) && !st.notCompanies.includes(v)) : [],
        others: hasJob ? st.job[kind].filter((v) => st.notCompanies.includes(v)) : [],
        waiting: null, pending: false,
        held: held && { jobtread: held.jobtread.map((s) => ({ slug: s, name: st.partners[s].name })), website: held.website.map((s) => ({ slug: s, name: st.partners[s].name })) },
      };
    }
    return { record: slug, name: kid.name, kinds };
  };
  // The list Partners → JobTread access reads: launch's questions and the names that aren't companies, and the last run
  const list = () => {
    const out = { byPartner: {}, unknown: [], held: [], owed: st.owed || [], last: st.last };
    for (const kind of ['designed', 'sponsored']) {
      const h = st.held[kind];
      if (h) out.held.push({ record: KID.slug, name: KID.name, kind, job: JOB, jobtread: h.jobtread.map((s) => ({ slug: s, name: st.partners[s].name })), website: h.website.map((s) => ({ slug: s, name: st.partners[s].name })) });
      for (const value of st.job[kind].filter((v) => !partnerBy(v) && !st.notCompanies.includes(v))) out.unknown.push({ record: KID.slug, name: KID.name, kind, value, job: JOB });
    }
    return out;
  };
  // As room-credits-admin.js answers: the new version only to an editor that had the one from just before
  const page = (slug, sent, before) => {
    const current = !!sent && sent === before;
    return { sha: current ? shaOf(slug) : null, behind: !current, page: { designers: recOf(slug).designers || [], sponsors: recOf(slug).sponsors || [], partnerLogos: recOf(slug).partnerLogos || [] } };
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
      const src = dir === 'src/content/kids' ? st.kids : dir === 'src/content/partners' ? st.partners : dir === 'src/content/community' ? st.projects : {};
      const items = Object.entries(src).map(([slug, c]) => ({ name: `${slug}.json`, path: `${dir}/${slug}.json`, sha: slug, content: c }));
      return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
    }
    if (p === '/api/read-content') {
      const m = url.searchParams.get('path').match(/^src\/content\/(kids|partners|community)\/(.+)\.json$/);
      const c = m && (m[1] === 'kids' ? st.kids : m[1] === 'community' ? st.projects : st.partners)[m[2]];
      return c ? json({ success: true, content: c, sha: m[1] === 'kids' ? shaOf(m[2]) : `sha-${m[2]}` }) : json({ success: false, error: 'Not found' }, 404);
    }
    if (p === '/api/save-content') {
      const b = body();
      const [, dir, slug] = b.path.match(/content\/(kids|partners)\/(.+)\.json$/) || [];
      const rec = JSON.parse(b.content);
      if (dir === 'partners') { st.partners[slug] = { ...rec, slug }; return json({ success: true, sha: `sha-${slug}` }); }
      // As save-content.js: the version must match, and the credits are kept as stored
      if (b.sha && st.kids[slug] && b.sha !== shaOf(slug)) return json({ success: false, error: 'Conflict: this item was changed since you loaded it. Reload to get the latest version.' }, 409);
      const before = st.kids[slug];
      st.kids[slug] = { ...rec, designers: before?.designers || [], sponsors: before?.sponsors || [] };
      (st.versions[slug] ||= []).push({ id: (st.versions[slug].length || 0) + 1, at: new Date().toISOString(), by: 'staff@soardcharity.com', data: st.kids[slug] });
      return json({ success: true, sha: bump(slug) });
    }
    if (p === '/api/content-history') {
      const q = url.searchParams;
      if (q.get('deleted')) return json({ success: true, deleted: [] });
      return json({ success: true, versions: (st.versions[q.get('slug')] || []).map((v) => ({ id: v.id, at: v.at, by: v.by, changed: null })).reverse() });
    }
    if (p === '/api/room-credits-admin') {
      if (!isPost) return url.searchParams.get('record') ? json({ success: true, room: room(url.searchParams.get('record')), last: st.last }) : json({ success: true, ...list() });
      const b = body();
      // JobTread takes a moment, as it does live (so a card's wait can be seen)
      const later = (o, status) => { setTimeout(() => json(o, status), 250); return true; };
      const target = b.set?.record || b.settle?.record || b.addBack?.record || b.sameAs?.record || b.notCompany?.record || KID.slug;
      // Without a record (Partners → JobTread access), the answer is the list, as the real one's
      const viewOf = (record) => (record ? { room: room(record) } : list());
      const before = shaOf(target);
      const sent = (b.set || b.settle || b.addBack || b.sameAs || b.notCompany || {}).sha || null;
      if (b.addBack) {
        const { record, partner } = b.addBack;
        const kid = recOf(record);
        const pt = st.partners[partner];
        let put = { logo: false, people: [], waiting: false, off: false };
        if (!logoOn(kid, pt)) { kid.partnerLogos = [{ url: pt.logo, name: pt.name }, ...(kid.partnerLogos || [])]; put.logo = true; put.logoUrl = pt.logo; }
        if (record === KID.slug && !st.onJob.has(partner)) { st.onJob.add(partner); put.people = [`${pt.name} main contact`]; }
        bump(record);
        return later({ success: true, put, ...page(record, sent, before), view: { room: room(record) } });
      }
      if (b.set) {
        const { record, kind, partner, on, put: putOn = true } = b.set;
        const kid = recOf(record);
        const pt = st.partners[partner];
        const field = RECORD[kind];
        let put = null;
        if (on) {
          kid[field] = [...new Set([...(kid[field] || []), partner])];
          if (record === KID.slug) {
            st.job[kind] = [...new Set([...st.job[kind], pt.name])];
            // Not on the makeover: on, once (logo and main contact)
            if (putOn && !logoOn(kid, pt) && !st.onJob.has(partner)) {
              kid.partnerLogos = [{ url: pt.logo, name: pt.name }, ...(kid.partnerLogos || [])];
              st.onJob.add(partner);
              put = { logo: true, logoUrl: pt.logo, people: [`${pt.name} main contact`], waiting: false, off: false };
            }
          }
        } else {
          kid[field] = (kid[field] || []).filter((s) => s !== partner);
          if (record === KID.slug) st.job[kind] = st.job[kind].filter((v) => v !== pt.name);
        }
        if (st.held[kind]) st.held[kind] = { ...st.held[kind], website: on ? [...new Set([...st.held[kind].website, partner])] : st.held[kind].website.filter((s) => s !== partner) };
        bump(record);
        return later({ success: true, record, kind, job: record === KID.slug ? JOB : null, put, credits: kid[field], ...page(record, sent, before), view: { room: room(record) } });
      }
      if (b.settle) {
        const { record, kind, use } = b.settle;
        const h = st.held[kind];
        if (use === 'jobtread') st.kids[record][RECORD[kind]] = [...new Set([...(st.kids[record][RECORD[kind]] || []), ...h.jobtread])];
        else st.job[kind] = st.job[kind].filter((v) => !h.jobtread.some((s) => st.partners[s].name === v));
        delete st.held[kind];
        bump(record);
        return later({ success: true, ...page(record, sent, before), view: { room: room(record) } });
      }
      if (b.sameAs) {
        st.links[b.sameAs.value] = b.sameAs.partner;
        // Knowing more about what JobTread says: the copy follows, nobody is put on
        for (const kind of ['designed', 'sponsored']) if (st.job[kind].includes(b.sameAs.value)) st.kids[KID.slug][RECORD[kind]] = [...new Set([...(st.kids[KID.slug][RECORD[kind]] || []), b.sameAs.partner])];
        bump(KID.slug);
        return later({ success: true, ...(b.sameAs.record ? page(KID.slug, sent, before) : {}), view: viewOf(b.sameAs.record) });
      }
      if (b.notCompany) {
        st.notCompanies = b.notCompany.undo ? st.notCompanies.filter((v) => v !== b.notCompany.value) : [...st.notCompanies, b.notCompany.value];
        return later({ success: true, ...(b.notCompany.record ? page(KID.slug, sent, before) : {}), view: viewOf(b.notCompany.record) });
      }
      return later({ success: false, error: 'Nothing to do' }, 400);
    }
    if (p === '/api/sponsors-admin') {
      const q = url.searchParams;
      if (!isPost && q.get('kid')) return json({ success: true, pledges: st.pledges[q.get('kid')] || {} });
      if (!isPost) return json({ success: true, contacts: Object.fromEntries(q.get('partners').split(',').map((s) => [s, st.contacts[s] || []])) });
      const b = body();
      if (b.contacts) {
        try { st.contacts[b.contacts.partner] = cleanPeople(b.contacts.people); } catch (e) { return json({ success: false, error: e.message }, 400); }
        return json({ success: true, contacts: st.contacts[b.contacts.partner], granted: [], problems: [] });
      }
      if (b.pledge) {
        const { kid, partner, pledged, received } = b.pledge;
        if (!(st.kids[kid]?.sponsors || []).includes(partner)) return json({ success: false, error: 'Save the kid with this sponsor first' }, 409);
        const amt = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[$,\s]/g, '')));
        const row = { pledged: amt(pledged) ?? 0, received: amt(received) ?? 0, updatedAt: new Date().toISOString(), by: 'staff@soardcharity.com' };
        st.pledges[kid] = { ...(st.pledges[kid] || {}), [partner]: row };
        return json({ success: true, pledge: row });
      }
      return json({ success: false, error: 'Nothing to do' }, 400);
    }
    if (p === '/api/vendor-access-admin') {
      const b = isPost ? body() : {};
      if (b.takeOff) {
        const kid = st.kids[b.takeOff.record];
        const pt = st.partners[b.takeOff.partner];
        const removed = (kid.partnerLogos || []).filter((l) => pt && (l.url === pt.logo || l.name === pt.name));
        kid.partnerLogos = (kid.partnerLogos || []).filter((l) => !removed.includes(l));
        if (pt) st.onJob.delete(pt.slug);
        return json({ success: true, result: { jobId: JOB, who: pt ? [`p:${pt.slug}`] : [], taken: pt ? [{ name: pt.name, people: ['main contact'] }] : [], removed, skipped: [], left: [], pending: [], sha: bump(b.takeOff.record) } });
      }
      if (b.addToJob) {
        for (const l of b.addToJob.logos || []) { const pt = Object.values(st.partners).find((x) => x.logo === l.url); if (pt) st.onJob.add(pt.slug); }
        return json({ success: true, result: { jobId: JOB, added: (b.addToJob.logos || []).map((l) => `${l.name} main contact`), waiting: [] } });
      }
      // Partners → JobTread access's list (no record): nothing waiting on vendors here, so only the credit questions show
      if (!isPost && !url.searchParams.get('record')) return json({ success: true, waiting: [], near: [], added: [], setAside: [], matched: [], twins: [], jtOnly: [], takenOff: [], roles: { on: true, pending: [], unplaced: [], recent: [] } });
      return json({ success: true, view: { rows: [], history: [] }, rows: [], history: [] });
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
  // A live logo the local server can't fetch (CORS on localhost) is the machine, not the page
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR|blocked by CORS policy/.test(m.text())) errors.push(m.text().slice(0, 300)); });
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
  // An older kid may be past the first screen: search for them
  const there = await page.evaluate((n) => [...document.querySelectorAll('.kd-row__name')].some((x) => x.textContent.trim() === n), name);
  if (!there) { await page.type('input[aria-label="Search kids"]', name); await sleep(500); }
  await page.evaluate((n) => [...document.querySelectorAll('.kd-row__name')].find((x) => x.textContent.trim() === n)?.click(), name);
  await page.waitForSelector('.kd-ed-head', { timeout: 10000 });
  await page.waitForFunction(() => !/Checking JobTread/.test(document.querySelector('#kd-sec-designer')?.innerText || 'Checking JobTread'), { timeout: 8000 }).catch(() => {});
  await sleep(400);
};
const cardText = (page, id) => page.$eval(id, (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\s+/g, ' ').trim()));
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false }).catch(() => {});
const lastCall = (api, path, pred = () => true) => [...api.st.calls].reverse().find((c) => c.path === path && pred(c));
const save = async (page) => { await page.waitForSelector('.kd-save', { timeout: 4000 }); await page.click('.kd-save'); await sleep(900); };

const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try {
  console.log(`\nDesktop 1440 (${KID.name}, awaiting funding, a JobTread job)`);
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goKids(page, false);
    await openKid(page, KID.name);
    const order = await page.$$eval('.kd-rail > section', (els) => els.map((e) => e.id || e.className.match(/kd-card--(\w+)/)?.[1]));
    ok(order[0] === 'status' && order[1] === 'kd-sec-sponsor' && order[2] === 'kd-sec-designer', `the two credit cards follow Status in the side panel (${order.slice(0, 4).join(', ')})`);
    let sp = await cardText(page, '#kd-sec-sponsor');
    ok(/Who’s paying for .* Pick them here or in JobTread’s Monetary Sponsor/.test(sp), 'awaiting funding: the sponsor card asks who’s paying, here or in JobTread');
    ok(/JobTread’s Monetary Sponsor says The Voila Foundation, which this page didn’t have/.test(sp), 'launch’s question is on the card');
    ok(/also says “SOARF”, which isn’t a company in Partners/.test(sp) && /“Carlos Fund”/.test(sp), 'names that aren’t companies in Partners are listed');
    ok(/Until someone says which is right \(above\), this page keeps its own answer/.test(sp) && !/The same as JobTread’s/.test(sp), 'while the question is open, the card never says it’s the same as JobTread');
    await shot(page, 'desktop-1-open');

    // Launch's question: Use JobTread's
    await clickText(page, '#kd-sec-sponsor button', 'Use JobTread’s');
    await page.waitForFunction(() => !/didn’t have/.test(document.querySelector('#kd-sec-sponsor')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    sp = await cardText(page, '#kd-sec-sponsor');
    ok(/The Voila Foundation/.test(sp) && !/didn’t have/.test(sp), 'Use JobTread’s: The Voila Foundation is the sponsor');
    ok(lastCall(api, '/api/room-credits-admin', (c) => c.body?.settle)?.body?.settle?.use === 'jobtread', 'it asked the server to keep JobTread’s');

    // Not a company, and Same as
    await clickText(page, '#kd-sec-sponsor button', 'Not a company');
    await page.waitForFunction(() => !/“SOARF”, which isn’t/.test(document.querySelector('#kd-sec-sponsor')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    ok(lastCall(api, '/api/room-credits-admin', (c) => c.body?.notCompany)?.body?.notCompany?.value === 'SOARF', 'Not a company: “SOARF” isn’t asked about again');
    ok(/which also says “SOARF”/.test(await cardText(page, '#kd-sec-sponsor')), 'and the JobTread line still shows it as JobTread says it');
    const carlos = api.st.partners['jimmy-helen-carlos'];
    if (carlos) {
      const sel = await page.$('#kd-sec-sponsor select.kd-credit__same');
      await sel.select(carlos.slug);
      await clickText(page, '#kd-sec-sponsor button', 'Link');
      await page.waitForFunction(() => !/“Carlos Fund”, which isn’t/.test(document.querySelector('#kd-sec-sponsor')?.innerText || ''), { timeout: 5000 }).catch(() => {});
      ok(lastCall(api, '/api/room-credits-admin', (c) => c.body?.sameAs)?.body?.sameAs?.partner === carlos.slug, `Same as: “Carlos Fund” is ${carlos.name}`);
      ok(new RegExp(carlos.name.replace(/[&]/g, '.')).test(await cardText(page, '#kd-sec-sponsor')), 'and it shows as a sponsor');
    }

    // Designed by: search by keyboard, pick
    let de = await cardText(page, '#kd-sec-designer');
    ok(/Who designed the room/.test(de), 'the design card asks who designed it');
    await page.click('#kd-sec-designer-q');
    await page.type('#kd-sec-designer-q', 'crosby');
    await page.waitForSelector('#kd-sec-designer-list [role=option]', { timeout: 3000 }).catch(() => {});
    const opt = await page.$eval('#kd-sec-designer-opt-0', (el) => el.innerText).catch(() => '');
    ok(/Crosby Design Group/.test(opt) && /Design/.test(opt), `the first match is Crosby Design Group, filed under Design (“${opt.replace(/\s+/g, ' ')}”)`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Crosby Design Group/.test(document.querySelector('#kd-sec-designer .kd-sponsors')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    const set1 = lastCall(api, '/api/room-credits-admin', (c) => c.body?.set)?.body?.set;
    ok(set1?.kind === 'designed' && set1.partner === 'crosby-design-group' && set1.on === true, 'the pick goes to the server at once');
    ok(api.st.job.designed.includes('Crosby Design Group'), 'JobTread’s Designed By now says Crosby Design Group');
    const said = (await toasts(page)).join(' | ');
    ok(/Crosby Design Group is the design partner, in JobTread’s Designed By too/.test(said) && /Their logo is on the page/.test(said), `the toast says what happened (${said.slice(0, 160)})`);
    const firstLogo = await page.$eval('.kd-logos li input', (el) => el.value).catch(() => '');
    ok(firstLogo === CROSBY.name, `their logo is on the page in the editor too (first: “${firstLogo}”)`);
    await shot(page, 'desktop-2-designer');

    // Save still works: the editor took in the page's new version
    // An edit of their own on the page, then Save
    await page.type('#kd-short', ' Edited.');
    await sleep(200);
    await save(page);
    const conflict = (await toasts(page)).some((t) => /Someone saved this profile/.test(t));
    ok(!conflict, 'Save after the pick: no conflict (the editor has the page’s new version)');
    ok(JSON.stringify(api.st.kids[KID.slug].designers) === '["crosby-design-group"]', 'the saved page keeps the credit');

    // Undo the pick: the credit off, and Crosby off the makeover (the pick put them on)
    await page.evaluate(() => [...document.querySelectorAll('.toast button')].find((b) => /Undo/.test(b.textContent) && /Crosby/.test(b.closest('.toast')?.innerText || ''))?.click());
    await page.waitForFunction(() => !/Crosby Design Group/.test(document.querySelector('#kd-sec-designer .kd-sponsors')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    ok(!api.st.job.designed.includes('Crosby Design Group'), 'Undo: Designed By no longer says Crosby');
    ok(lastCall(api, '/api/vendor-access-admin', (c) => c.body?.takeOff)?.body?.takeOff?.partner === 'crosby-design-group', 'and Crosby is taken off the makeover, since the pick put them on');

    // Credited but not on the makeover: Add them back
    api.st.kids[KID.slug].designers = ['crosby-design-group'];
    api.st.onJob.delete('crosby-design-group');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.reload({ waitUntil: 'networkidle2' });
    await goKids(page, false);
    await openKid(page, KID.name);
    de = await cardText(page, '#kd-sec-designer');
    ok(/Crosby Design Group isn’t on this makeover now/.test(de), 'credited but not on the makeover: the card says so');
    await clickText(page, '#kd-sec-designer button', 'Add them back');
    await page.waitForFunction(() => !/isn’t on this makeover now/.test(document.querySelector('#kd-sec-designer')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    ok(lastCall(api, '/api/room-credits-admin', (c) => c.body?.addBack)?.body?.addBack?.partner === 'crosby-design-group', 'Add them back puts them back on the makeover now');
    ok(api.st.onJob.has('crosby-design-group') && api.st.kids[KID.slug].partnerLogos.some((l) => l.name === CROSBY.name), 'their logo on the page and them on the job');
    ok(!(await page.$('.kd-save')), 'nothing left to save: the editor took in the page');

    // Both cards picked one right after the other, then Save: the second pick carries the first one's new version,
    // so Save goes through (one request at a time for the page)
    // While one card's request is out, both cards wait (one request at a time for the page): the second pick goes
    // the moment the first is back, as fast as a person could
    const pickFast = async (id, q) => { await page.waitForFunction((i) => !document.querySelector(`${i}-q`)?.disabled, { timeout: 8000 }, id); await page.click(`${id}-q`); await page.type(`${id}-q`, q); await page.waitForSelector(`${id}-list [role=option]`, { timeout: 3000 }).catch(() => {}); await page.keyboard.press('Enter'); };
    await pickFast('#kd-sec-sponsor', 'carlos');
    ok(await page.$eval('#kd-sec-designer-q', (e) => e.disabled).catch(() => false), 'while the sponsor pick is out, the design card waits too');
    await pickFast('#kd-sec-designer', 'means');
    await page.waitForFunction(() => /Means Interiors/.test(document.querySelector('#kd-sec-designer .kd-sponsors')?.innerText || ''), { timeout: 8000 }).catch(() => {});
    await sleep(500);
    await page.type('#kd-short', ' Both.');
    await sleep(200);
    await save(page);
    ok(!(await toasts(page)).some((t) => /Someone saved this profile/.test(t)), 'two picks back to back, then Save: no conflict');
    const two = api.st.calls.filter((c) => c.path === '/api/room-credits-admin' && c.body?.set).slice(-2).map((c) => c.body.set.sha);
    ok(two.length === 2 && two[0] !== two[1], 'the second pick carried the first one’s new version');

    // Taking a credit off is the credit only
    await page.evaluate(() => document.querySelector('#kd-sec-sponsor .kd-sponsors .kd-x')?.click());
    await sleep(700);
    const off = lastCall(api, '/api/room-credits-admin', (c) => c.body?.set && c.body.set.on === false)?.body?.set;
    ok(off?.kind === 'sponsored', 'the X takes the sponsor credit off');
    ok(/Their logo and place on the job stay/.test((await toasts(page)).join(' | ')), 'the toast says the logo and place on the job stay');
    await page.evaluate(() => [...document.querySelectorAll('.toast button')].reverse().find((b) => /Undo/.test(b.textContent) && /no longer/.test(b.closest('.toast')?.innerText || ''))?.click());
    await sleep(700);
    const undo = lastCall(api, '/api/room-credits-admin', (c) => c.body?.set)?.body?.set;
    ok(undo?.on === true && undo.put === false, 'Undo puts the credit back, and only the credit');

    // Someone else saved the page after it was opened: a pick doesn't hide that; Save says so
    api.st.kids[KID.slug] = { ...api.st.kids[KID.slug], status: 'in-progress' };
    api.st.shas[KID.slug] = 'sha-elsewhere';
    await page.click('#kd-sec-designer-q');
    await page.type('#kd-sec-designer-q', 'means');
    await page.waitForSelector('#kd-sec-designer-list [role=option]', { timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Enter');
    await sleep(700);
    ok(lastCall(api, '/api/room-credits-admin', (c) => c.body?.set)?.body?.set?.sha && lastCall(api, '/api/room-credits-admin', (c) => c.body?.set).body.set.sha !== 'sha-elsewhere', 'the pick carries the version the editor has');
    await page.type('#kd-short', ' Again.');
    await sleep(200);
    await save(page);
    ok((await toasts(page)).some((t) => /Someone saved this profile after you opened it/.test(t)), 'Save says someone else changed the page, rather than putting their change back');

    // Contacts and a pledge for a sponsor
    await page.click('#kd-sec-sponsor-q');
    await page.type('#kd-sec-sponsor-q', 'voila');
    await page.waitForSelector('#kd-sec-sponsor-list [role=option]', { timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /The Voila Foundation/.test(document.querySelector('#kd-sec-sponsor .kd-sponsors')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    await clickText(page, '#kd-sec-sponsor button', 'Add a contact');
    await page.waitForSelector('#kd-sp-contact-name-0', { timeout: 5000 }).catch(() => {});
    if (await page.$('#kd-sp-contact-name-0')) {
      await page.type('#kd-sp-contact-name-0', 'Dana Reed');
      await page.type('#kd-sp-contact-email-0', 'dana@voilafdn.org');
      await clickText(page, '.kd-dialog__foot button', 'Save');
      await page.waitForFunction(() => /dana@voilafdn\.org/.test(document.querySelector('#kd-sec-sponsor')?.innerText || ''), { timeout: 5000 }).catch(() => {});
      ok(/dana@voilafdn\.org/.test(await cardText(page, '#kd-sec-sponsor')), 'the sponsor’s contact is listed on the card');
    } else ok(false, 'the contacts dialog opens');
    const pledge = await page.$('#kd-sec-sponsor .kd-pledge input[aria-label^="Pledged by"]');
    ok(!!pledge, 'the sponsor takes a pledge right away (it’s saved with the credit)');
    if (pledge) {
      await pledge.type('$5,000');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => /Saved/.test(document.querySelector('#kd-sec-sponsor .kd-pledge')?.innerText || ''), { timeout: 5000 }).catch(() => {});
      ok(lastCall(api, '/api/sponsors-admin', (c) => c.body?.pledge)?.body?.pledge?.pledged === '$5,000', 'the pledge is saved');
    }

    for (const id of ['#kd-sec-sponsor', '#kd-sec-designer']) {
      const ax = await axeScan(page, id);
      ok(!ax.length, `axe: ${id} has no WCAG A/AA violations ${axeText(ax)}`);
    }
    await shot(page, 'desktop-3-end');

    // Partners: what Crosby did, room by room (the question this started from). The conflict above left edits
    // unsaved, so the page asks before leaving: yes
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.reload({ waitUntil: 'networkidle2' });
    await clickText(page, '.nav-item', 'Partners');
    await page.waitForSelector('.pt-row', { timeout: 15000 });
    await page.type('input[aria-label="Search partners"]', 'Crosby');
    await sleep(800);
    const clicked = await page.evaluate((n) => { const b = [...document.querySelectorAll('.ppl-row__name')].find((e) => e.textContent.trim() === n); b?.click(); return b ? 'ok' : [...document.querySelectorAll('.ppl-row__name')].slice(0, 6).map((e) => e.textContent.trim()).join(', '); }, CROSBY.name);
    if (clicked !== 'ok') { await shot(page, 'debug-partners'); console.log(`  (rows: ${clicked}; hash ${await page.evaluate(() => location.hash)})`); }
    await page.waitForSelector('.pt-ed-head', { timeout: 10000 }).catch(async () => { await shot(page, 'debug-partner-editor'); console.log(`  (editor didn’t open; errors: ${errors.slice(-3).join(' | ')})`); });
    await sleep(500);
    const facts = await page.evaluate(() => [...document.querySelectorAll('.kd-facts div')].map((d) => d.innerText.replace(/\s+/g, ' ').trim()));
    const first = String(KID.name).split(/\s+/)[0];
    ok(facts.some((f) => new RegExp(`^Designed ${first} ${KID.year}`).test(f)), `Crosby in Partners: “Designed ${first} ${KID.year}” (${facts.filter((f) => /Designed|sponsor/.test(f)).join(' | ')})`);
    const kidLine = await page.evaluate((n) => [...document.querySelectorAll('.pt-kid__text')].find((e) => e.querySelector('strong')?.textContent.trim() === n)?.innerText.replace(/\s+/g, ' ') || '', KID.name);
    ok(/Designed it/.test(kidLine), `and their kid list says what they did there (“${kidLine}”)`);
    const head = await page.$eval('.kd-ed-id__sub', (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '');
    ok(/Designed 1 room/.test(head), `and the top of their page says it at a glance (“${head}”)`);
    await shot(page, 'desktop-4-partner');
    ok(!errors.length, `no console errors (${errors.slice(0, 3).join(' | ')})`);
    await page.close();
  }

  console.log(`\nDesktop 1440 (${NOJOB.name}, no JobTread job)`);
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goKids(page, false);
    await openKid(page, NOJOB.name);
    const de = await cardText(page, '#kd-sec-designer');
    ok(/No JobTread job for this kid yet, so it’s kept on this page/.test(de), 'a kid with no job: kept on the page until there is one');
    await page.click('#kd-sec-designer-q');
    await page.type('#kd-sec-designer-q', 'crosby');
    await page.waitForSelector('#kd-sec-designer-list [role=option]', { timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Crosby Design Group/.test(document.querySelector('#kd-sec-designer .kd-sponsors')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    ok(JSON.stringify(api.st.kids[NOJOB.slug].designers) === '["crosby-design-group"]', 'picked: on the page’s record');
    ok(!api.st.calls.some((c) => c.path === '/api/vendor-access-admin' && c.body?.addToJob), 'nobody put on any job');
    ok(!/your logo/.test((await toasts(page)).join(' ')), 'no logo talk for a room with no job');
    ok(!errors.length, `no console errors (${errors.slice(0, 3).join(' | ')})`);
    await page.close();
  }

  const PROJECT = Object.values(PROJECTS0)[0];
  console.log(`\nDesktop 1440 (community project ${PROJECT.name}, no JobTread job)`);
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await clickText(page, '.nav-item', 'Kids');
    await page.waitForSelector('.hub-tab', { timeout: 15000 });
    await clickText(page, '.hub-tab', 'Community Projects');
    await page.waitForSelector('.cm-row', { timeout: 15000 });
    await page.evaluate((s) => document.querySelector(`.cm-row[data-slug="${s}"] .kd-row__name`)?.click(), PROJECT.slug);
    await page.waitForSelector('.kd-ed-head', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#kd-sec-designer') && !/Checking JobTread/.test(document.querySelector('#kd-sec-designer').innerText), { timeout: 8000 }).catch(() => {});
    const order = await page.$$eval('.kd-rail > section', (els) => els.map((e) => e.id || e.className.match(/kd-card--(\w+)/)?.[1]));
    ok(order.includes('kd-sec-sponsor') && order.includes('kd-sec-designer'), `the project has the same two cards (${order.slice(0, 4).join(', ')})`);
    ok(/No JobTread job for this project yet/.test(await cardText(page, '#kd-sec-designer')), 'it says “this project”');
    await page.click('#kd-sec-designer-q');
    await page.type('#kd-sec-designer-q', 'crosby');
    await page.waitForSelector('#kd-sec-designer-list [role=option]', { timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Crosby Design Group/.test(document.querySelector('#kd-sec-designer .kd-sponsors')?.innerText || ''), { timeout: 5000 }).catch(() => {});
    const set = lastCall(api, '/api/room-credits-admin', (c) => c.body?.set)?.body?.set;
    ok(set?.record === `community/${PROJECT.slug}` && set.kind === 'designed', `the pick is for community/${PROJECT.slug}`);
    ok(!(await page.$('#kd-sec-sponsor .kd-pledge')), 'no pledge box on a project (pledges are kids’)');
    ok(!errors.length, `no console errors (${errors.slice(0, 3).join(' | ')})`);
    await page.close();
  }

  console.log('\nPartners → JobTread access (1440, then 390): what JobTread’s credit fields say that needs a person');
  for (const vp of [{ width: 1440, height: 1000, mobile: false }, { width: 390, height: 844, mobile: true }]) {
    const { page, api, errors } = await open(browser, vp);
    api.st.last = { at: new Date().toISOString(), problems: [`${KID.name}: couldn’t put Crosby Design Group on the room yet (tried again next run): JobTread is down`] };
    // A change JobTread keeps refusing, on an older kid's (finished) job
    api.st.owed = [{ record: NOJOB.slug, name: NOJOB.name, kind: 'designed', job: '22POWEDJOB01', tries: 3, error: 'JobTread: job is closed' }];
    if (vp.mobile) { await page.evaluate(() => document.querySelector('.hamburger')?.click()); await sleep(350); }
    await clickText(page, '.nav-item', 'Partners');
    await page.waitForSelector('.pt-ready__access', { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('.pt-ready__access .spinner'), { timeout: 8000 }).catch(() => {});
    await sleep(400);
    const tile = await page.$eval('.pt-ready__access', (e) => e.innerText.replace(/\s+/g, ' ').trim());
    ok(/JobTread access 4\b/i.test(tile) && new RegExp(`${KID.name}: whose Monetary Sponsor\\?`).test(tile), `the JobTread access tile counts the four things waiting and names the first (“${tile}”)`);
    await page.click('.pt-ready__access');
    await page.waitForSelector('.pt-access__credits', { timeout: 8000 }).catch(() => {});
    await sleep(300);
    const sec = () => page.$eval('.pt-access__credits', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
    const askIn = (value, label) => page.evaluate((value, label) => {
      const box = [...document.querySelectorAll('.pt-access__credits .kd-credit__ask')].find((e) => e.innerText.includes(value));
      const b = box && [...box.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(label));
      if (b) b.click();
      return !!b;
    }, value, label);
    let t = await sec();
    ok(t.includes(`JobTread’s Monetary Sponsor says The Voila Foundation, which ${KID.name}’s page didn’t have`), 'launch’s question, saying whose page');
    ok(t.includes(`“SOARF” is in JobTread’s Monetary Sponsor on ${KID.name}’s page, and isn’t a company in Partners`) && t.includes('“Carlos Fund”'), 'each name that isn’t a company, with the page it’s on');
    ok(/couldn’t finish one thing/.test(t) && /couldn’t put Crosby Design Group on the room yet/.test(t), 'the last run’s problem is said, as Automations points here');
    ok(t.includes(`${NOJOB.name} · the job in JobTread`) && /JobTread hasn’t taken a change to this job’s Designed By \(tried 3 times: JobTread: job is closed\)/.test(t), 'a change JobTread keeps refusing: whose, which field, and why');
    await shot(page, `access-${vp.width}`);
    const ax = await axeScan(page, '.pt-access__credits');
    ok(!ax.length, `axe: the credits section at ${vp.width}px ${axeText(ax)}`);
    if (vp.mobile) {
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(wide <= 0, `no sideways scroll (${wide}px over)`);
      const out = await page.$$eval('.pt-access__credits *', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); const m = e.closest('.modal')?.getBoundingClientRect(); return m && r.width && (r.right > m.right + 1 || r.left < m.left - 1); }).map((e) => e.tagName + '.' + e.className).slice(0, 4));
      ok(!out.length, `nothing pokes out of the dialog (${out.join(', ')})`);
      const small = await page.$$eval('.pt-access__credits button, .pt-access__credits select', (els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.textContent.trim() || e.id).slice(0, 4));
      ok(!small.length, `44px touch targets (${small.join(', ')})`);
    } else {
      // Not a company: from here, for every page
      ok(await askIn('SOARF', 'Not a company'), 'Not a company is there');
      await page.waitForFunction(() => !/“SOARF” is in/.test(document.querySelector('.pt-access__credits')?.innerText || ''), { timeout: 5000 }).catch(() => {});
      const nc = lastCall(api, '/api/room-credits-admin', (c) => c.body?.notCompany)?.body?.notCompany;
      ok(nc?.value === 'SOARF' && !nc.record, 'Not a company: “SOARF”, for every page (no one page named)');
      ok((await toasts(page)).some((x) => /not asked about again/.test(x)), 'and the toast says so, with Undo');
      // Same as a partner
      const carlos = Object.values(PARTNERS0).find((x) => x.slug === 'jimmy-helen-carlos') || Object.values(PARTNERS0).find((x) => /carlos/i.test(x.name));
      await page.select(`#pt-credit-same-sponsored-${nameKey('Carlos Fund')}`, carlos.slug);
      ok(await askIn('Carlos Fund', 'Link'), 'Same as a partner… Link');
      await page.waitForFunction(() => !/“Carlos Fund”/.test(document.querySelector('.pt-access__credits')?.innerText || ''), { timeout: 5000 }).catch(() => {});
      const sa = lastCall(api, '/api/room-credits-admin', (c) => c.body?.sameAs)?.body?.sameAs;
      ok(sa?.value === 'Carlos Fund' && sa.partner === carlos.slug && !sa.record, `Same as: “Carlos Fund” is ${carlos.name}, everywhere`);
      // Use JobTread's
      ok(await askIn('The Voila Foundation', 'Use JobTread’s'), 'Use JobTread’s');
      await page.waitForFunction(() => !/didn’t have/.test(document.querySelector('.pt-access__credits')?.innerText || ''), { timeout: 5000 }).catch(() => {});
      const se = lastCall(api, '/api/room-credits-admin', (c) => c.body?.settle)?.body?.settle;
      ok(se?.record === KID.slug && se.use === 'jobtread', 'settled for that page: JobTread’s kept');
      t = await sec();
      ok(!/didn’t have|isn’t a company in Partners/.test(t), 'nothing left to ask');
      await page.keyboard.press('Escape');
      await sleep(400);
      const after = await page.$eval('.pt-ready__access', (e) => e.innerText.replace(/\s+/g, ' ').trim());
      ok(/JobTread access 1\b/i.test(after), `and the tile counts only what’s left (“${after}”)`);
      await shot(page, 'access-1440-settled');
    }
    ok(!errors.length, `no console errors (${errors.slice(0, 3).join(' | ')})`);
    await page.close();
  }

  console.log('\nPhone 390');
  {
    const { page, errors } = await open(browser, { width: 390, height: 844, mobile: true });
    await goKids(page, true);
    await openKid(page, KID.name);
    await page.evaluate(() => document.querySelector('#kd-sec-designer')?.scrollIntoView());
    await sleep(300);
    await shot(page, 'phone-1-cards');
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(wide <= 0, `no sideways scroll (${wide}px over)`);
    const overflow = await page.$$eval('#kd-sec-sponsor *, #kd-sec-designer *', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); const c = e.closest('.kd-card').getBoundingClientRect(); return r.width && (r.right > c.right + 1 || r.left < c.left - 1); }).map((e) => e.className || e.tagName).slice(0, 5));
    ok(!overflow.length, `nothing pokes out of the cards (${overflow.join(', ')})`);
    const small = await page.$$eval('#kd-sec-sponsor button, #kd-sec-designer button, #kd-sec-sponsor select, #kd-sec-designer select', (els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => `${e.textContent.trim().slice(0, 30)} ${Math.round(e.getBoundingClientRect().height)}px`));
    ok(!small.length, `44px touch targets in the cards (${small.join(', ')})`);
    for (const id of ['#kd-sec-sponsor', '#kd-sec-designer']) {
      const ax = await axeScan(page, id);
      ok(!ax.length, `axe on a phone: ${id} ${axeText(ax)}`);
    }
    ok(!errors.length, `no console errors (${errors.slice(0, 3).join(' | ')})`);
    await page.close();
  }
} finally {
  await browser.close();
  stopDev();
}
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll passed.');
process.exit(failures.length ? 1 : 0);
