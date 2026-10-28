/**
 * test-partners-admin.mjs — drive Admin → Partners in a real browser
 * ===================================================================
 * Loads the admin from an Astro dev server (so Preview can frame the real
 * Partners page) with every /api/* call answered from an in-memory copy of a
 * frozen set of partners, kids, community partners, media logos and press
 * (tests/fixtures/partners-admin.json), and Cloudflare Images answered here
 * for sizes (format=json), file types and the two test-only logo files.
 * Checks, at 1440px, 820px (iPad) and 390px:
 *   - sections by level in page order, tab counts, what each row is missing,
 *     the readiness tiles (each a filter), search and "/", the logo wall
 *   - reordering Signature by keyboard and Champion by dragging: one
 *     /api/reorder-content request each, Undo
 *   - the row menu (move to a level, highlight, delete), selecting rows and
 *     changing level, categories and highlight for all of them, with Undo
 *   - logos on kid pages that aren't in the directory, and adding one
 *   - adding a partner (duplicate warning, web address tidied, level order)
 *   - Recently deleted and restoring
 *   - the editor: level picker, live card preview, health checks, website
 *     checks, a new logo (the old file is never deleted) and switching kid
 *     pages to it, kid pages that show an older logo, history and restore,
 *     merging a save made meanwhile, opening a kid page, Preview
 *   - Community partners (hidden section note, reorder, editor, logo) and
 *     (Media logos moved to Press → Outlets: scripts/test-press-admin.mjs covers them)
 *   - phone: Select mode, nothing past the content column, 44px targets
 * Screenshots land in test-results/partners-admin/. Exits non-zero on any
 * failure or console error.
 *
 *   SITE=http://localhost:4321 node scripts/test-partners-admin.mjs
 * Without SITE it starts `astro dev` on a spare port and stops it after.
 * AXE=<path to axe.min.js> adds an accessibility pass (WCAG 2.1 AA and best
 * practice) on each screen; axe-core isn't a dependency of the site.
 */
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as PS from '../public/admin/partners-shared.js';
import { hoverSweep } from './lib/hover-sweep.mjs';
import { answerAsks } from './lib/ask.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test-results/partners-admin/');
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

const FX = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/partners-admin.json'), 'utf8'));
const HASH = PS.CF_HASH;
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;
// Images: a logo-ish PNG for the test-only files and uploads, and a file to upload
const PNG_SMALL = await sharp({ create: { width: 60, height: 20, channels: 4, background: { r: 40, g: 90, b: 160, alpha: 1 } } }).png().toBuffer();
const PNG_LOGO = await sharp({ create: { width: 900, height: 300, channels: 4, background: { r: 230, g: 60, b: 50, alpha: 1 } } }).png().toBuffer();
const UPLOAD = join(OUT, 'upload-logo.png');
writeFileSync(UPLOAD, PNG_LOGO);
// Wide empty margins: Mohawk's file is a 600 × 600 square with the logo (412 × 132) in the middle,
// MSI's is an SVG whose viewBox has the same kind of room
const PNG_PADDED = await sharp({ create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await sharp({ create: { width: 412, height: 132, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 1 } } }).png().toBuffer(), left: 94, top: 234 }]).png().toBuffer();
const SVG_PADDED = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300"><rect x="200" y="120" width="200" height="60" fill="#7a5c2e"/></svg>';
const PADDED = { mohawk: 'png', msi: 'svg' };
// A file that draws nothing at all (Matilda Jane's, in the real data): every pixel transparent
const PNG_BLANK = await sharp({ create: { width: 320, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
const cfCalls = [];
const paddedOf = (path) => PADDED[Object.keys(PADDED).find((k) => path.includes(`/partners/${k}/`))];
let OFFLINE = false;

// ── The fake API ──
const DIR = { partners: 'partners', kids: 'kids', communityPartners: 'communityPartners', medialogos: 'medialogos', press: 'press', site: 'site' };
const TABLE = { partners: 'partners', kids: 'kids', communityPartners: 'community_partners', medialogos: 'medialogos', press: 'press', site: 'site' };
function makeApi() {
  const st = { calls: [], n: 0, shas: {}, versions: {}, deleted: [], waiting: new Set(), deletedImages: [], conflictOnce: null, uploads: [] };
  // Waiting for a logo (functions/api/kid-partners-admin.js): a Sponsor on a JobTread job whose company has no logo anywhere
  const since = new Date(Date.now() - 3 * 3600e3).toISOString();
  st.logos = {
    waiting: [{ record: 'isla', company: 'kindneighborsfund', name: 'Kind Neighbors Fund', jobId: 'jt-isla', hint: null,
      people: [{ name: 'Nia Nguyen', email: 'nia@kindneighbors.example', role: 'Sponsor' }], page: { slug: 'isla', name: 'Isla', year: 2026, kind: 'kid', draft: false },
      since, updatedAt: since, emailedAt: since },
    { record: 'isla', company: 'bellcabinets', name: 'Bell Cabinets', jobId: 'jt-isla', hint: 'Partners has Bell Cabinetry: the same company?',
      people: [{ name: 'Ben Bell', email: 'ben@bellcabinets.example', role: 'Vendor' }], page: { slug: 'isla', name: 'Isla', year: 2026, kind: 'kid', draft: false },
      since, updatedAt: since, emailedAt: since }],
    links: [],
    dismissed: [], added: [{ record: 'isla', company: 'bellcabinetry', name: 'Bell Cabinetry', people: [], page: { slug: 'isla', name: 'Isla', year: 2026, kind: 'kid', draft: false }, updatedAt: since }],
    settings: { emails: ['linzi@example.org'], updatedAt: null }, lastError: null,
  };
  for (const k of Object.keys(DIR)) st[k] = structuredClone(FX[k] || {});
  for (const k of Object.keys(DIR)) for (const [slug, d] of Object.entries(st[k])) d.slug ||= slug;
  const key = (dir, slug) => `${dir}/${slug}`;
  const shaOf = (dir, slug) => st.shas[key(dir, slug)] || `sha-${dir}-${slug}-0`;
  const bump = (dir, slug) => { st.shas[key(dir, slug)] = `sha-${dir}-${slug}-${++st.n}`; return st.shas[key(dir, slug)]; };
  const record = (dir, slug, before, after, action = 'save') => {
    const list = (st.versions[key(dir, slug)] ||= []);
    if (!list.length && before) list.push({ id: ++st.n, at: new Date(Date.now() - 86400000).toISOString(), by: null, action: 'save', data: structuredClone(before) });
    list.push({ id: ++st.n, at: new Date().toISOString(), by: 'admin@example.com', action, data: structuredClone(after) });
  };
  // Someone else saves meanwhile (another tab)
  st.external = (dir, slug, patch) => { const before = structuredClone(st[dir][slug]); st[dir][slug] = { ...before, ...patch }; record(dir, slug, before, st[dir][slug]); bump(dir, slug); };
  const pathOf = (path) => { const m = String(path).match(/^src\/content\/([^/]+)\/(.+)\.json$/); return m ? { dir: m[1], slug: m[2] } : null; };
  const respond = (req) => {
    const url = new URL(req.url());
    const p = url.pathname;
    if (!p.startsWith('/api/')) return false;
    const json = (o, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(o) });
    const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } };
    st.calls.push({ path: p, method: req.method(), body: req.method() === 'POST' && !/upload/.test(p) ? body() : null, query: url.search });
    if (p === '/api/list-content') {
      const dir = url.searchParams.get('dir').replace('src/content/', '');
      const items = Object.entries(st[dir] || {}).map(([slug, c]) => ({ name: `${slug}.json`, path: `src/content/${dir}/${slug}.json`, sha: shaOf(dir, slug), content: c }));
      return json({ success: true, items, count: items.length, total: items.length, pages: 1 });
    }
    if (p === '/api/read-content') {
      const at = pathOf(url.searchParams.get('path'));
      const c = at && st[at.dir]?.[at.slug];
      if (!c && at?.dir === 'site' && url.searchParams.get('optional') === '1') return json({ success: false, notFound: true, error: 'Not found' });
      return c ? json({ success: true, content: c, sha: shaOf(at.dir, at.slug) }) : json({ success: false, error: 'Not found' }, 404);
    }
    if (p === '/api/save-content') {
      const b = body();
      const at = pathOf(b.path);
      if (!at || !st[at.dir]) return json({ success: false, error: 'Path not allowed' }, 403);
      if (st.conflictOnce && st.conflictOnce.slug === at.slug) { const c = st.conflictOnce; st.conflictOnce = null; st.external(at.dir, at.slug, c.patch); }
      if (b.sha && st[at.dir][at.slug] && b.sha !== shaOf(at.dir, at.slug)) return json({ success: false, error: 'Conflict: this item was changed since you loaded it. Reload to get the latest version.' }, 409);
      const before = st[at.dir][at.slug] ? structuredClone(st[at.dir][at.slug]) : null;
      st[at.dir][at.slug] = JSON.parse(b.content);
      record(at.dir, at.slug, before, st[at.dir][at.slug]);
      st.waiting.add(`${TABLE[at.dir]}:${at.slug}`);
      return json({ success: true, sha: bump(at.dir, at.slug) });
    }
    if (p === '/api/delete-content') {
      const at = pathOf(body().path);
      const c = at && st[at.dir]?.[at.slug];
      if (!c) return json({ success: false, error: 'not found' }, 404);
      record(at.dir, at.slug, null, c, 'delete');
      st.deleted.push({ dir: at.dir, slug: at.slug, data: structuredClone(c), id: st.versions[key(at.dir, at.slug)].at(-1).id });
      delete st[at.dir][at.slug];
      return json({ success: true });
    }
    if (p === '/api/reorder-content') {
      const b = body();
      const dir = Object.keys(TABLE).find((d) => TABLE[d] === b.collection);
      const changed = [];
      for (const it of b.items || []) {
        const c = st[dir]?.[it.slug];
        if (!c) return json({ success: false, error: `Not found: ${it.slug}` }, 409);
        if (c.order !== it.order) { st[dir][it.slug] = { ...c, order: it.order }; bump(dir, it.slug); changed.push(it.slug); }
      }
      return json({ success: true, changed, shas: {} });
    }
    if (p === '/api/partners-batch') {
      const b = body();
      if (b.swapLogo) {
        const changed = [];
        for (const [slug, k] of Object.entries(st.kids)) {
          if (!(k.partnerLogos || []).some((l) => PS.cfId(l.url) === PS.cfId(b.swapLogo.from))) continue;
          st.kids[slug] = { ...k, partnerLogos: k.partnerLogos.map((l) => (PS.cfId(l.url) === PS.cfId(b.swapLogo.from) ? { ...l, url: b.swapLogo.to, name: l.name || b.swapLogo.name } : l)) };
          changed.push(slug);
        }
        return json({ success: true, changed, conflicts: [], shas: {} });
      }
      // As functions/api/partners-batch.js: only the fields asked for, Save's rules for just those
      const changed = [];
      const next = {};
      for (const l of ['signature', 'champion']) next[l] = Object.values(st.partners).filter((x) => x.level === l).reduce((m, x) => Math.max(m, (x.order || 0) + 1), 0);
      for (const u of b.updates || []) {
        const before = st.partners[u.slug];
        if (!before) return json({ success: false, error: `Not found: ${u.slug}` }, 409);
        const patch = { ...(u.set || {}) };
        if (u.add?.length || u.remove?.length) {
          const start = 'category' in patch ? (patch.category || []) : PS.categoryUnset(before) ? [] : PS.categoriesOf(before);
          const list = [...new Set([...start, ...(u.add || [])])].filter((c) => !(u.remove || []).includes(c));
          if (list.length) patch.category = list;
        }
        if (u.addFolders?.length || u.removeFolders?.length) patch.logoFolders = [...new Set([...(before.logoFolders || []), ...(u.addFolders || [])])].filter((f) => !(u.removeFolders || []).includes(f));
        if (patch.level && patch.order == null && patch.level !== (before.level || 'friend') && next[patch.level] != null) patch.order = next[patch.level]++;
        const after = PS.applyPartnerChange(before, patch);
        if (Array.isArray(after.logoFolders) && !after.logoFolders.length) delete after.logoFolders;
        if (JSON.stringify(after) === JSON.stringify(before)) continue;
        st.partners[u.slug] = after;
        record('partners', u.slug, before, after);
        bump('partners', u.slug);
        changed.push(u.slug);
      }
      return json({ success: true, changed, conflicts: [], shas: {} });
    }
    if (p === '/api/content-history') {
      const collection = url.searchParams.get('collection');
      const dir = Object.keys(TABLE).find((d) => TABLE[d] === collection);
      if (url.searchParams.get('deleted')) {
        return json({ success: true, deleted: st.deleted.filter((d) => d.dir === dir && !st[dir][d.slug]).reverse().map((d) => ({ id: d.id, slug: d.slug, name: d.data.name, image: d.data.logo || null, at: new Date().toISOString(), by: 'admin@example.com' })) });
      }
      const list = st.versions[key(dir, url.searchParams.get('slug'))] || [];
      const id = url.searchParams.get('id');
      if (id) { const v = list.find((x) => x.id === Number(id)); return v ? json({ success: true, data: v.data }) : json({ success: false, error: 'That version is gone' }, 404); }
      return json({ success: true, versions: list.map((v, i) => ({ id: v.id, at: v.at, by: v.by, action: v.action, changed: i ? Object.keys({ ...v.data, ...list[i - 1].data }).filter((k) => JSON.stringify(v.data[k]) !== JSON.stringify(list[i - 1].data[k])) : null })).reverse() });
    }
    if (p === '/api/upload-image') {
      // The file's bytes (multipart), so checks can read what was uploaded
      const n = ++st.n;
      req.fetchPostData().catch(() => '').then((d) => { st.uploads.push(d || ''); json({ success: true, imageUrl: img(`partners/uploaded/${n}`) }); });
      return true;
    }
    if (p === '/api/delete-image') { st.deletedImages.push(body().imageId); return json({ success: true }); }
    if (p.startsWith('/api/pending-changes')) {
      return json({ success: true, changes: [...st.waiting].map((k) => { const [type, slug] = k.split(':'); return { type, slug, name: slug, state: 'waiting', action: 'updated', at: new Date().toISOString() }; }), publish: { live: null, active: null, failed: null, typicalSeconds: 480 } });
    }
    if (p.startsWith('/api/deployments')) return json({ success: true, deploys: [], source: 'cloudflare' });
    if (p.startsWith('/api/live-ws')) { req.abort(); return true; }
    if (p === '/api/kid-partners-admin') {
      if (req.method() !== 'POST') return json({ success: true, ...st.logos });
      const b = body();
      const one = b.dismiss || b.undismiss;
      if (one) {
        const [from, to] = b.dismiss ? ['waiting', 'dismissed'] : ['dismissed', 'waiting'];
        const r = st.logos[from].find((x) => x.record === one.record && x.company === one.company);
        if (!r) return json({ success: false, error: 'That one isn’t waiting any more' }, 404);
        st.logos[from] = st.logos[from].filter((x) => x !== r);
        st.logos[to].push({ ...r, by: 'admin@example.com' });
        return json({ success: true, state: to, view: st.logos });
      }
      if (b.link) {
        const r = st.logos.waiting.find((x) => x.company === b.link.company);
        st.logos.waiting = st.logos.waiting.filter((x) => x !== r);
        st.logos.links.push({ company: b.link.company, partner: b.link.partner, name: r?.name || b.link.company });
        if (r) st.logos.added.unshift({ ...r, updatedAt: new Date().toISOString() });
        return json({ success: true, added: r ? [{ record: r.record, name: r.page.name, added: [st.partners[b.link.partner]?.name] }] : [], view: st.logos });
      }
      if (b.unlink) { st.logos.links = st.logos.links.filter((l) => l.company !== b.unlink.company); return json({ success: true, added: [], view: st.logos }); }
      if (b.settings) {
        const bad = b.settings.emails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        if (bad) return json({ success: false, error: `${bad} doesn’t look like an email address` }, 400);
        st.logos.settings = { emails: b.settings.emails.map((e) => e.toLowerCase()), updatedAt: new Date().toISOString() };
        return json({ success: true, settings: st.logos.settings });
      }
    }
    return json({ success: true, ok: true });
  };
  return { st, respond };
}

// Cloudflare Images: sizes and file types answered here; the test-only files served here
function cfRespond(req) {
  const u = new URL(req.url());
  const isCf = u.hostname === 'imagedelivery.net' || u.pathname.startsWith('/cdn-cgi/imagedelivery/');
  if (!isCf) return false;
  const path = u.pathname.replace(/^\/cdn-cgi\/imagedelivery/, '');
  cfCalls.push(`${req.method()} ${path}`);
  if (OFFLINE) { req.abort('internetdisconnected'); return true; }
  if (/\/blank\//.test(path)) {
    if (path.endsWith('/f=json')) { req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"width":320,"height":200}' }); return true; }
    if (req.method() === 'HEAD') { req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'image/png' }, body: '' }); return true; }
    req.respond({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: PNG_BLANK });
    return true;
  }
  if (/\/gone\//.test(path)) { req.respond({ status: 404, body: 'gone', headers: { 'Access-Control-Allow-Origin': '*' } }); return true; }
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const pad = paddedOf(path);
  if (pad === 'svg') {
    if (req.method() === 'HEAD') { req.respond({ status: 200, headers: { ...cors, 'Content-Type': 'image/svg+xml' }, body: '' }); return true; }
    if (/\/public$/.test(path)) { req.respond({ status: 200, contentType: 'image/svg+xml', headers: cors, body: SVG_PADDED }); return true; }
  }
  // Measuring and cropping (scale-down copies) read the test's own images: padded ones, else a plain logo with no margins
  if (/fit=scale-down/.test(path)) { req.respond({ status: 200, contentType: 'image/png', headers: cors, body: pad === 'png' ? PNG_PADDED : PNG_LOGO }); return true; }
  const tiny = /\/tiny\//.test(path);
  const ours = tiny || /\/partners\/uploaded\//.test(path);
  if (path.endsWith('/f=json')) {
    const [w, h] = tiny ? [60, 20] : paddedOf(path) === 'png' ? [600, 600] : [1200, 400];
    req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ width: w, height: h, original: { width: w, height: h } }) });
    return true;
  }
  if (req.method() === 'HEAD') { req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'image/png' }, body: '' }); return true; }
  if (ours) { req.respond({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: tiny ? PNG_SMALL : PNG_LOGO }); return true; }
  return false; // the real logos load from Cloudflare, so screenshots look like the admin
}

async function open(browser, { width, height, mobile, hash = '' }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on('dialog', (d) => d.accept());
  await answerAsks(page);
  const api = makeApi();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if (new URL(req.url()).origin === SITE && api.respond(req) !== false) return;
    if (cfRespond(req) !== false) return;
    req.continue();
  });
  await page.goto(`${SITE}/admin/index.html${hash}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.nav-item, .sidebar', { timeout: 20000 });
  return { page, api, errors };
}

const $text = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
const clickText = (page, sel, text) => page.evaluate((sel, text) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.replace(/\s+/g, ' ').trim().startsWith(text));
  if (el) el.click();
  return !!el;
}, sel, text);
async function shot(page, name, { grow = true } = {}) {
  const vp = page.viewport();
  try {
    const h = grow ? await page.evaluate(() => Math.min(Math.max(document.documentElement.scrollHeight, document.querySelector('.main')?.scrollHeight || 0), 7000)) : 0;
    if (h > vp.height) await page.setViewport({ ...vp, height: h });
    await sleep(150);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
  } catch (e) {
    console.log(`  (screenshot ${name} failed: ${e.message.slice(0, 80)})`);
  } finally {
    if (page.viewport()?.height !== vp.height) await page.setViewport(vp).catch(() => {});
  }
  // Nothing on screen may lose its label under the pointer (scripts/lib/hover-sweep.mjs)
  for (const f of await hoverSweep(page, hoverSeen)) ok(false, `${name}: “${f.text}” in “${f.label}” drops to ${f.hover}:1 under the pointer (${f.resting}:1 resting, ${f.colors})`);
  // Leave the pointer out of the way, so what comes next doesn't start under a hover
  await page.mouse.move(1, 1).catch(() => {});
}
const hoverSeen = new Set();
async function goPartners(page, tab, mobile) {
  if (mobile) { await page.evaluate(() => document.querySelector('.hamburger')?.click()); await sleep(350); }
  await clickText(page, '.nav-item', 'Partners');
  await page.waitForSelector('.hub-tabs', { timeout: 10000 });
  if (tab) { await clickText(page, '.hub-tab', tab); await sleep(300); }
  if (!tab || tab === 'Partners') await page.waitForSelector('.pt-row', { timeout: 10000 });
  await sleep(400);
}
const rowNames = (page, level) => page.$$eval(`.pt-section--${level} .ppl-row__name`, (els) => els.map((e) => e.textContent.trim()));
const lastCall = (api, path) => [...api.st.calls].reverse().find((c) => c.path === path);
const callsTo = (api, path) => api.st.calls.filter((c) => c.path === path).length;
const rowMenu = async (page, name, item) => {
  await page.evaluate((name) => [...document.querySelectorAll('.pt-row')].find((r) => r.querySelector('.ppl-row__name')?.textContent.trim() === name)?.querySelector('.ppl-menu__btn')?.click(), name);
  await page.waitForSelector('.ppl-menu__pop', { timeout: 3000 });
  await sleep(50);
  return clickText(page, '.ppl-menu__pop [role="menuitem"]', item);
};
const dialogTitle = () => document.querySelector('.kd-dialog h2')?.textContent.trim() || null;
const typeInto = (page, sel, value) => page.$eval(sel, (i, v) => { i.focus(); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }, value);
const waitToast = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), { timeout: 6000 }, re.source).then(() => true).catch(() => false);
const clickToastAction = (page, re) => page.evaluate((src) => { const t = [...document.querySelectorAll('.toast')].reverse().find((x) => new RegExp(src).test(x.textContent)); t?.querySelector('.toast-undo')?.click(); return !!t; }, re.source);
const overflow = (page) => page.evaluate(() => {
  const main = document.querySelector('.main')?.getBoundingClientRect();
  if (!main) return [];
  return [...document.querySelectorAll('.main *')].filter((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= main.right + 1) return false;
    return !el.closest('.hub-tabs, .ppl-filters, .kd-bar__chips, [class*="overflow"], .kd-hist__list') && getComputedStyle(el).position !== 'fixed';
  }).slice(0, 5).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)} right=${Math.round(el.getBoundingClientRect().right)}`);
});

// Accessibility (optional): axe-core on the admin, the Partners screens only
const axeRules = { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } };
async function axeCheck(page, label) {
  if (!process.env.AXE) return;
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: process.env.AXE });
  await sleep(350); // let dialogs finish opening and hover transitions settle
  const v = await page.evaluate(async (opts) => {
    const r = await window.axe.run(document.querySelector('.modal-overlay') || document.querySelector('.main'), opts);
    return r.violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  }, axeRules);
  ok(!v.length, `accessibility, ${label}${v.length ? `: ${v.join('; ')}` : ''}`);
}

// What the list should say, from the same rules, with the sizes answered above
const fxPartners = Object.values(FX.partners).map((p, i) => ({ ...p, slug: p.slug || Object.keys(FX.partners)[i] }));
const fxSizeOf = (p) => (/\/tiny\//.test(p.logo || '') ? [60, 20] : [1200, 400]);
// The padded logos' margins, from their geometry (the browser measures them on a 240px copy)
const fxMargins = (p) => {
  const pad = paddedOf(p.logo || '');
  const level = PS.withDefaults(p).level;
  if (pad === 'png') return PS.marginFactor([600, 600], PS.cropBox({ x: 94, y: 234, w: 412, h: 132 }, 600, 600), level);
  if (pad === 'svg') return PS.marginFactor([600, 300], PS.cropBox({ x: 200, y: 120, w: 200, h: 60 }, 600, 300), level);
  return 1;
};
const fxIssues = (p) => PS.issuesOf(p, { broken: /\/gone\//.test(p.logo || ''), blank: /\/blank\//.test(p.logo || ''), size: PS.inDirectory(PS.withDefaults(p)) ? undefined : paddedOf(p.logo || '') === 'svg' ? 'svg' : fxSizeOf(p),
  margins: fxMargins(p), dupes: PS.duplicatesOf(fxPartners).get(p.slug) || [] });
const fxSections = PS.sections(fxPartners);
const fxUsage = PS.kidUsage(Object.values(FX.kids), fxPartners);

// No GPU and no background throttling: with the Mac's display asleep, Chrome's
// GPU path stops producing frames and every screenshot times out
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 60000,
  args: ['--disable-gpu', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
try {
  // ════════ Desktop ════════
  console.log('Desktop 1440');
  {
    const { page, api, errors } = await open(browser, { width: 1440, height: 1000, mobile: false });
    await goPartners(page);
    const tabs = await $text(page, '.hub-tab');
    ok(tabs.length === 2 && tabs[0] === `Partners${fxPartners.length}` && tabs[1] === `Community partners${Object.keys(FX.communityPartners).length}`, `tab counts (${tabs.join(' | ')})`);
    for (const l of PS.LEVELS) {
      const names = await rowNames(page, l.id);
      ok(JSON.stringify(names) === JSON.stringify(fxSections[l.id].map((p) => p.name.trim())), `${l.label}: ${names.length} rows in page order`);
      if (process.env.DEBUG && JSON.stringify(names) !== JSON.stringify(fxSections[l.id].map((p) => p.name))) console.log(names, fxSections[l.id].map((p) => p.name));
    }
    // Readiness tiles, once every logo is checked
    await page.waitForFunction(() => !document.querySelector('.ppl-ready__tile .spinner'), { timeout: 20000 }).catch(() => {});
    const tiles = await $text(page, '.ppl-ready__tile');
    const logoFix = fxPartners.filter((p) => fxIssues(p).some((i) => i.tone === 'warn' && (i.id === 'logo' || i.id === 'logo-blank' || i.id === 'logo-small' || i.id === 'margins'))).length;
    await page.waitForFunction(() => !/hecking/.test(document.querySelector('.ppl-ready__tile')?.textContent || ''), { timeout: 30000 }).catch(() => {});
    const tile0 = (await $text(page, '.ppl-ready__tile'))[0];
    ok(tile0.startsWith(`Logos${fxPartners.length - logoFix} of ${fxPartners.length}${logoFix} to fix`), `Logos tile: ${logoFix} to fix: no logo, a missing file, a blank one, a blurry one, two with wide margins (${tile0})`);
    const noWeb = fxPartners.filter((p) => fxIssues(p).some((i) => i.id === 'website')).length;
    ok(tiles[1].includes(`${noWeb} without a link`), `Websites tile (${tiles[1]})`);
    ok(tiles[3].includes(`${fxUsage.unmatched[0].name} is on ${fxUsage.unmatched[0].kids.length} kid pages`) && tiles[3].includes(String(fxUsage.unmatched.length)), `logos on kid pages not in the directory (${tiles[3]})`);
    const chips = (name) => page.evaluate((name) => [...document.querySelectorAll('.pt-row')].find((r) => r.querySelector('.ppl-row__name')?.textContent.trim() === name)?.querySelector('.ppl-row__issues')?.textContent.trim() || '', name);
    ok(/Logo missing/.test(await chips(FX.partners['jackson-healthcare'].name)), 'a logo file that’s gone reads “Logo missing”');
    ok(/Blurry logo/.test(await chips(FX.partners['gas-south'].name)), 'a 60px logo in the Champions grid reads “Blurry logo”');
    ok(/Website isn’t a link/.test(await chips(FX.partners['trident-construction-group'].name)), '“tridentconstructiongroup” isn’t a link');
    ok(/Possible duplicate/.test(await chips(FX.partners['33n'].name)) && /Possible duplicate/.test(await chips(FX.partners['deck-south'].name)), 'two partners with one website are possible duplicates');
    ok(/No tagline/.test(await chips(FX.partners.pella.name)), 'Signature partners without a tagline say so');
    await page.waitForFunction(() => document.querySelectorAll('.ppl-chip').length && [...document.querySelectorAll('.ppl-chip')].filter((c) => c.textContent.includes('Wide margins')).length >= 2, { timeout: 15000 }).catch(() => {});
    ok(/Wide margins/.test(await chips(FX.partners.mohawk.name)) && /Wide margins/.test(await chips(FX.partners.msi.name)), 'logos drawn small by empty margins say so (a PNG and an SVG)');
    ok(!/Wide margins/.test(await chips(FX.partners.pella.name)), 'a logo that fills its file doesn’t');
    ok(/Blank logo/.test(await chips(FX.partners['a-color-affair'].name)), 'a logo file that draws nothing (all transparent) reads “Blank logo”, not healthy');
    await page.evaluate((n) => [...document.querySelectorAll('.ppl-row__name')].find((e) => e.textContent.trim() === n)?.click(), FX.partners['a-color-affair'].name);
    await page.waitForSelector('.pt-ed-head');
    await page.waitForFunction(() => /Logo file is blank/.test(document.querySelector('.kd-card--health')?.textContent || ''), { timeout: 8000 }).catch(() => {});
    const blankHealth = await $text(page, '.kd-card--health .kd-checks li');
    ok(blankHealth.includes('Logo file is blank') && !blankHealth.some((t) => /sharp|margins/i.test(t)), `a blank logo’s health asks for a new file, without sharpness or margin checks (${blankHealth.join(', ')})`);
    ok(/blank/.test(await page.$eval('.pt-logo-stage', (e) => e.textContent)) && !(await page.$('.pt-logo-stage .pt-logo-stage__side .spinner')), 'its logo stage asks for a new upload, and isn’t left measuring');
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.pt-row');
    const dismissedRead = api.st.calls.find((c) => c.path === '/api/read-content' && /partner-logo-dismissed/.test(decodeURIComponent(c.query)));
    ok(/optional=1/.test(dismissedRead?.query || ''), 'the “not a partner” list is read as optional: none yet is no error');
    ok(/Crop logo margins\s*2/.test(await page.$eval('.pt-crop-btn', (b) => b.textContent).catch(() => '')), 'the header offers to crop both');
    const sub = await page.evaluate(() => [...document.querySelectorAll('.pt-row')].find((r) => r.textContent.includes('Bell Cabinetry'))?.querySelector('.ppl-row__sub')?.textContent);
    ok(/bellcabinetry\.com · On 4 kid pages \(2025–2026\)/.test(sub || ''), `rows say where a partner links and how many kid pages show them (${sub})`);
    await shot(page, 'desk-list');
    await axeCheck(page, 'desktop list');

    // Tiles filter; search with "/"
    await clickText(page, '.ppl-ready__tile', 'Logos');
    await sleep(200);
    const shown = await page.$$eval('.pt-row', (r) => r.length);
    ok(shown === logoFix, `the Logos tile shows just the ${logoFix} to fix (${shown})`);
    await clickText(page, '.ppl-ready__tile', 'Logos');
    await page.keyboard.press('/');
    ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Search partners'), '“/” jumps to search');
    await page.keyboard.type('pella');
    await sleep(200);
    ok(JSON.stringify(await $text(page, '.pt-row .ppl-row__name')) === '["Pella"]', 'search finds Pella');
    await typeInto(page, 'input[aria-label="Search partners"]', '');
    const attention = fxPartners.filter((p) => fxIssues(p).some((i) => i.tone === 'warn')).length;
    const att = await page.evaluate(() => [...document.querySelectorAll('.ppl-filter')].find((b) => b.textContent.startsWith('Needs attention'))?.textContent);
    ok(att.replace(/\s+/g, ' ').trim() === `Needs attention ${attention}`, `Needs attention counts ${attention} (${att})`);

    // Logo wall
    await clickText(page, '.pt-view button', 'Logos');
    await page.waitForSelector('.pt-tile', { timeout: 3000 });
    ok(await page.$$eval('.pt-wall--signature .pt-tile', (t) => t.length) === fxSections.signature.length, 'Logos view: Signature logos at their card size');
    await sleep(1200);
    await shot(page, 'desk-logos');
    await axeCheck(page, 'logo wall');
    await clickText(page, '.pt-view button', 'List');
    await page.waitForSelector('.pt-row');

    // Reorder Signature by keyboard: one request, then Undo
    const sig0 = await rowNames(page, 'signature');
    await page.focus('.pt-section--signature .ppl-handle');
    await page.keyboard.press('Space');
    await sleep(150);
    await page.keyboard.press('ArrowDown');
    await sleep(250);
    await page.keyboard.press('Space');
    await sleep(500);
    const re = lastCall(api, '/api/reorder-content');
    if (process.env.DEBUG) console.log(JSON.stringify(re?.body), api.st.calls.slice(-6).map((c) => c.path), await $text(page, '.toast'));
    ok(re?.body.collection === 'partners' && re.body.items.length === sig0.length && re.body.items[1].slug === fxSections.signature[0].slug && re.body.items[1].order === 1,
      'keyboard reorder: one request with every Signature partner in its new place');
    await page.waitForFunction((n) => document.querySelectorAll('.pt-section--signature .ppl-row__name')[1]?.textContent.trim() === n, { timeout: 4000 }, sig0[0]).catch(() => {});
    ok((await rowNames(page, 'signature'))[1] === sig0[0], `${sig0[0]} moved down one`);
    ok(await waitToast(page, /Signature order saved/), 'toast: Signature order saved, with Undo');
    await clickToastAction(page, /Signature order saved/);
    await sleep(600);
    ok(JSON.stringify(await rowNames(page, 'signature')) === JSON.stringify(sig0), 'Undo puts the order back');
    ok(!(await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /Signature order saved/.test(t.textContent)))), 'Undo closes its toast: “Order put back” replaces it');

    // Drag Champion with the mouse
    const ch0 = await rowNames(page, 'champion');
    await page.$eval('.pt-section--champion', (el) => el.scrollIntoView({ block: 'start' }));
    await sleep(200);
    const handles = await page.$$('.pt-section--champion .ppl-handle');
    const a = await handles[0].boundingBox();
    const b2 = await handles[2].boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + ((b2.y - a.y + 8) * i) / 10); await sleep(30); }
    await page.mouse.up();
    await page.waitForFunction((n) => document.querySelectorAll('.pt-section--champion .ppl-row__name')[2]?.textContent.trim() === n, { timeout: 4000 }, ch0[0]).catch(() => {});
    await sleep(400);
    const ch1 = await rowNames(page, 'champion');
    const dragCall = lastCall(api, '/api/reorder-content');
    if (process.env.DEBUG) console.log('drag', ch0, ch1, JSON.stringify(dragCall?.body).slice(0, 200));
    ok(ch1[2] === ch0[0] && dragCall?.body.items.length === ch0.length && dragCall.body.items[2].slug === fxSections.champion[0].slug, `drag: ${ch0[0]} dropped third in Champions, one request`);

    // Row menu: move a Friend to Champion (end of the section), then Undo
    const friend = fxSections.friend[0];
    await rowMenu(page, friend.name, 'Move to Champion');
    await page.waitForFunction((n) => [...document.querySelectorAll('.pt-section--champion .ppl-row__name')].some((e) => e.textContent.trim() === n), { timeout: 5000 }, friend.name).catch(() => {});
    const mv = lastCall(api, '/api/partners-batch');
    ok(mv?.body.updates?.[0]?.slug === friend.slug && mv.body.updates[0].set.level === 'champion', `row menu: “Move to Champion” sends one change for ${friend.name}`);
    ok((await rowNames(page, 'champion')).at(-1) === friend.name, `${friend.name} joins the end of the Champions`);
    await clickToastAction(page, /moved to Champion/);
    await page.waitForFunction((n) => [...document.querySelectorAll('.pt-section--friend .ppl-row__name')].some((e) => e.textContent.trim() === n), { timeout: 5000 }, friend.name).catch(() => {});
    ok(api.st.partners[friend.slug].level === 'friend' && api.st.partners[friend.slug].order === 0, 'Undo moves them back to Friend, A to Z');

    // Select rows, change categories and highlight for all of them
    const pick = fxSections.friend.slice(0, 3);
    for (const p of pick) await page.evaluate((n) => [...document.querySelectorAll('.pt-row')].find((r) => r.querySelector('.ppl-row__name')?.textContent.trim() === n)?.querySelector('.pt-check')?.click(), p.name);
    await page.waitForSelector('.pt-selectbar');
    ok((await page.$eval('.pt-selectbar strong', (e) => e.textContent)) === '3 partners selected', 'the selection bar counts 3');
    await typeInto(page, 'input[aria-label="Search partners"]', pick[0].name);
    await sleep(200);
    ok(/2 hidden by the search; changes apply to all 3/.test(await page.$eval('.pt-selectbar', (e) => e.textContent)), 'the bar says when the search hides some of the selection');
    await typeInto(page, 'input[aria-label="Search partners"]', '');
    await sleep(150);
    await clickText(page, '.pt-selectbar button', 'Categories');
    await page.waitForSelector('.pt-catpick');
    await clickText(page, '.pt-catpick__btn', 'Design');
    await clickText(page, '.kd-dialog__foot .btn', 'Save for 3');
    await page.waitForFunction(() => !document.querySelector('.pt-catpick'), { timeout: 5000 }).catch(() => {});
    const cat = lastCall(api, '/api/partners-batch');
    ok(cat?.body.updates?.length === 3 && cat.body.updates.every((u) => JSON.stringify(u.add) === '["design"]' && !u.remove?.length), 'Categories: Design added on each of the 3 (their other categories kept)');
    ok(pick.every((p) => PS.categoriesOf(api.st.partners[p.slug]).includes('design')), 'all 3 now in Design');
    await shot(page, 'desk-selected');
    await axeCheck(page, 'selection bar');
    await page.evaluate(() => document.querySelector('.pt-selectbar .ppl-menu__btn, .pt-selectbar .ppl-head-menu, .pt-selectbar [aria-haspopup="menu"]:nth-of-type(2)'));
    const hlBtn = await page.$$('.pt-selectbar [aria-haspopup="menu"]');
    await hlBtn[1].click();
    await page.waitForSelector('.ppl-menu__pop', { timeout: 3000 }).catch(() => {});
    if (process.env.DEBUG) console.log('hl menu', hlBtn.length, await $text(page, '.ppl-menu__pop [role=menuitem]'), await page.evaluate((b) => b.outerHTML.slice(0, 200), hlBtn[1]));
    await clickText(page, '.ppl-menu__pop [role="menuitem"]', 'Highlight in the directory');
    await sleep(700);
    if (process.env.DEBUG) console.log(JSON.stringify(lastCall(api, '/api/partners-batch')?.body), pick.map((p) => api.st.partners[p.slug].featured), await $text(page, '.toast'));
    ok(pick.every((p) => api.st.partners[p.slug].featured === true), 'Highlight: all 3 highlighted in the directory');
    await clickToastAction(page, /highlighted in the directory/);
    await sleep(600);
    const undoHl = lastCall(api, '/api/partners-batch');
    ok(undoHl?.body.updates?.length === 3 && undoHl.body.updates.every((u) => JSON.stringify(Object.keys(u.set)) === '["featured"]'), 'Undo puts back only the highlight, nothing else');
    ok(pick.every((p) => !api.st.partners[p.slug].featured), 'and they’re no longer highlighted');
    await clickText(page, '.pt-selectbar button', 'Clear');
    ok(!(await page.$('.pt-selectbar')), 'Clear ends the selection');

    // Logos on kid pages that aren't listed: the same partner under an older name, a partner to add, or not a partner
    await clickText(page, '.ppl-ready__tile', 'On kid pages, not listed');
    await page.waitForSelector('.pt-loose');
    ok(await page.evaluate(dialogTitle) === 'On kid pages, not in the directory', 'the review tile opens the list of unlisted logos');
    await axeCheck(page, 'unlisted logos dialog');
    const firstLoose = await page.$eval('.pt-loose__item strong', (e) => e.textContent);
    ok(firstLoose === fxUsage.unmatched[0].name, `most kid pages first (${firstLoose})`);
    const suggest = await page.$eval('.pt-loose__item .pt-same-as', (b) => b.textContent.trim()).catch(() => '');
    ok(suggest === 'Same as Construction Resources', `CR Construction is probably Construction Resources (initials and a shared word): “${suggest}”`);
    await shot(page, 'desk-unlisted', { grow: false });
    await page.click('.pt-loose__item .pt-same-as');
    await page.waitForSelector('.pt-loose__item.is-linked', { timeout: 5000 }).catch(() => {});
    const link = lastCall(api, '/api/partners-batch');
    ok(link?.body.updates?.[0]?.slug === 'construction-resources' && JSON.stringify(link.body.updates[0].addFolders) === JSON.stringify(fxUsage.unmatched[0].folders),
      `“Same as” links CR Construction’s upload folders (${fxUsage.unmatched[0].folders.join(', ')}) to Construction Resources`);
    ok(JSON.stringify(api.st.partners['construction-resources'].logoFolders) === JSON.stringify(fxUsage.unmatched[0].folders), 'saved on the partner as logoFolders');
    await clickText(page, '.pt-loose__item.is-linked .btn', 'Show their current logo there');
    await page.waitForFunction(() => !document.querySelector('.pt-loose__item.is-linked'), { timeout: 6000 }).catch(() => {});
    const crLogo = api.st.partners['construction-resources'].logo;
    const crKids = fxUsage.unmatched[0].kids.map((k) => k.slug);
    ok(crKids.every((k) => api.st.kids[k].partnerLogos.some((l) => l.url === crLogo)), `their current logo now shows on all ${crKids.length} of those kid pages`);
    // Add one that isn't in the directory yet
    const addName = await page.evaluate(() => [...document.querySelectorAll('.pt-loose__item')].find((li) => !li.querySelector('.pt-same-as'))?.querySelector('strong')?.textContent);
    await page.evaluate((n) => [...document.querySelectorAll('.pt-loose__item')].find((li) => li.querySelector('strong')?.textContent === n)?.querySelectorAll('.btn').forEach((b) => { if (b.textContent.includes('Add to directory')) b.click(); }), addName);
    await page.waitForSelector('#pt-new-name');
    ok((await page.$eval('#pt-new-name', (i) => i.value)) === addName, `Add to directory starts with their name (${addName})`);
    await clickText(page, '.kd-dialog__foot .btn', 'Add partner');
    await page.waitForFunction(() => !document.querySelector('#pt-new-name'), { timeout: 6000 }).catch(() => {});
    const added = Object.values(api.st.partners).find((x) => x.name === addName);
    const addGroup = fxUsage.unmatched.find((g) => g.name === addName);
    ok(added?.level === 'friend' && PS.cfId(added.logo) === PS.cfId(addGroup.url), `${addName} added as a Friend with the logo from their newest build`);
    // And one that isn't a partner at all
    await page.waitForSelector('.pt-loose__not');
    const notName = await page.$eval('.pt-loose__item strong', (e) => e.textContent);
    await page.click('.pt-loose__not');
    await page.waitForSelector('.pt-loose__dismissed', { timeout: 5000 }).catch(() => {});
    const notKey = fxUsage.unmatched.find((g) => g.name === notName)?.key;
    ok(api.st.site['partner-logo-dismissed']?.keys?.includes(notKey), `“Not a partner” sets ${notName} aside, saved for everyone`);
    ok(/1 logo marked not a partner/.test(await page.$eval('.pt-loose__dismissed', (e) => e.textContent).catch(() => '')), 'the dialog keeps it under “marked not a partner”, to undo');
    await page.keyboard.press('Escape');
    await sleep(300);
    const tile3 = (await $text(page, '.ppl-ready__tile'))[3];
    ok(tile3.includes(String(fxUsage.unmatched.length - 3)), `three fewer unlisted: linked, added, set aside (${tile3})`);
    const crSub = await page.evaluate(() => [...document.querySelectorAll('.pt-row')].find((r) => r.querySelector('.ppl-row__name')?.textContent.trim() === 'Construction Resources')?.querySelector('.ppl-row__sub')?.textContent);
    const crCount = new Set([...(fxUsage.byPartner.get('construction-resources') || []), ...fxUsage.unmatched[0].kids].map((k) => k.slug)).size;
    ok(new RegExp(`On ${crCount} kid pages`).test(crSub || ''), `Construction Resources now counts their old CR Construction pages (${crSub})`);

    // From JobTread, no logo yet: who the company is, who to ask, which page; add them, or no logo needed
    const tile4 = (await $text(page, '.ppl-ready__tile'))[4] || '';
    ok(/JobTread, no logo\s*2\s*Kind Neighbors Fund, for Isla’s page/.test(tile4), `the JobTread tile counts what’s waiting and names the first (${tile4})`);
    const tileBox = await page.$$eval('.ppl-ready__tile', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    ok(new Set(tileBox).size === 1, `five tiles in one row at 1440 (${tileBox.join(', ')})`);
    await clickText(page, '.ppl-ready__tile', 'JobTread, no logo');
    await page.waitForSelector('.pt-wait .pt-loose__item', { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(dialogTitle) === 'Waiting for a logo', 'the tile opens Waiting for a logo');
    const waitText = await page.$eval('.pt-wait .pt-loose__item', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
    ok(/Kind Neighbors Fund/.test(waitText) && /Sponsor on Isla’s page \(2026\) · the job in JobTread · first seen/.test(waitText) && /Nia Nguyen · nia@kindneighbors\.example/.test(waitText), `each row: the company, their role and page, the person and their email (${waitText.slice(0, 160)})`);
    ok(await page.$eval('.pt-wait a[href^="mailto:"]', (a) => a.getAttribute('href')).catch(() => '') === 'mailto:nia@kindneighbors.example', 'the email address is a mail link');
    ok(await page.$eval('.pt-wait .pt-loose__text small a[href^="#kids/"]', (a) => a.getAttribute('href')).catch(() => '') === '#kids/isla', '“Isla’s page” goes to her editor');
    ok(await page.$eval('.pt-wait .pt-loose__text small a[href*="app.jobtread.com/jobs/"]', (a) => a.getAttribute('href')).catch(() => '') === 'https://app.jobtread.com/jobs/jt-isla', 'and the job opens in JobTread');
    ok(await page.$eval('#pt-wait-emails', (i) => i.value).catch(() => '') === 'linzi@example.org', 'who’s emailed, from the saved list');
    await shot(page, 'desk-waiting', { grow: false });
    await axeCheck(page, 'waiting for a logo');
    // JobTread calls Bell Cabinetry “Bell Cabinets”: “Same as” links them, for this job and every one after
    const bellActs = await page.evaluate(() => [...document.querySelectorAll('.pt-wait .pt-loose__item')].find((li) => li.querySelector('strong')?.textContent === 'Bell Cabinets')?.querySelector('.pt-loose__acts')?.textContent.replace(/\s+/g, ' ').trim() || '');
    ok(/^Add to Partners\s*Same as Bell Cabinetry\?/.test(bellActs), `a word in common offers “Same as Bell Cabinetry?” after Add to Partners (${bellActs.slice(0, 80)})`);
    await clickText(page, '.pt-wait .pt-same-as', 'Same as Bell Cabinetry');
    ok(await waitToast(page, /Bell Cabinets is Bell Cabinetry: their logo is on 1 page now/), 'linked: the toast says their logo is on Isla’s page now');
    const linkCall = lastCall(api, '/api/kid-partners-admin');
    ok(linkCall?.body?.link?.company === 'bellcabinets' && linkCall.body.link.partner === 'bell', 'the link names the company and the partner');
    ok(!(await page.evaluate(() => [...document.querySelectorAll('.pt-wait .pt-loose__item strong')].some((e) => e.textContent === 'Bell Cabinets'))), 'and it leaves the waiting list');
    ok(/1 company JobTread names differently, linked to a partner/.test(await page.$eval('.kd-dialog', (d) => d.textContent).catch(() => '')), 'the dialog lists the link, to undo');
    await clickText(page, '.pt-wait .btn', 'Add to Partners');
    await page.waitForSelector('#pt-new-name');
    ok((await page.$eval('#pt-new-name', (i) => i.value)) === 'Kind Neighbors Fund' && (await page.$eval('#pt-new-web', (i) => i.value)) === 'https://kindneighbors.example',
      'Add to Partners starts with their name, and their email’s domain as the website');
    ok(/Sponsor on Isla’s page\. Add their logo here and it goes on that page by itself/i.test(await page.$eval('.kd-dialog', (d) => d.textContent).catch(() => '')), 'and says the logo goes on Isla’s page by itself');
    await clickText(page, '.kd-dialog__foot .btn', 'Cancel');
    await page.waitForSelector('.pt-wait', { timeout: 3000 }).catch(() => {});
    ok(await page.evaluate(dialogTitle) === 'Waiting for a logo', 'Cancel goes back to the waiting list');
    await clickText(page, '.pt-wait .btn', 'No logo needed');
    await page.waitForSelector('.pt-wait__none', { timeout: 5000 }).catch(() => {});
    ok(lastCall(api, '/api/kid-partners-admin')?.body?.dismiss?.company === 'kindneighborsfund', '“No logo needed” sets it aside');
    ok(/doesn’t need one/.test(await page.$eval('.pt-wait__none', (e) => e.textContent).catch(() => '')), 'the list says nothing is waiting');
    ok(await clickToastAction(page, /no logo needed/), 'with an Undo');
    await page.waitForSelector('.pt-wait .pt-loose__item', { timeout: 5000 }).catch(() => {});
    ok(api.st.logos.waiting.length === 1 && lastCall(api, '/api/kid-partners-admin')?.body?.undismiss, 'Undo puts it back on the list');
    await typeInto(page, '#pt-wait-emails', 'linzi@example.org, nope');
    await clickText(page, '.pt-wait__emails .btn', 'Save');
    ok(await waitToast(page, /nope doesn’t look like an email address/), 'a bad address is refused');
    await typeInto(page, '#pt-wait-emails', 'Linzi@example.org, pm@example.org');
    await clickText(page, '.pt-wait__emails .btn', 'Save');
    ok(await waitToast(page, /Missing logos go to linzi@example\.org, pm@example\.org/), 'saved: both are emailed now');
    await page.keyboard.press('Escape');
    await sleep(300);

    // Add a partner: duplicate warning, web address tidied, Champion goes last
    await clickText(page, '.ppl-head__actions .btn', 'Add a partner');
    await page.waitForSelector('#pt-new-name');
    await typeInto(page, '#pt-new-name', 'Pella');
    await sleep(150);
    ok(await page.$eval('.pt-same', (e) => /Already in the directory: Pella/.test(e.textContent)).catch(() => false), 'typing an existing name warns it’s already listed');
    await typeInto(page, '#pt-new-name', 'Acme Tile Co.');
    await typeInto(page, '#pt-new-web', 'acmetile.com');
    await page.$eval('#pt-new-web', (i) => i.blur());
    await sleep(100);
    ok((await page.$eval('#pt-new-web', (i) => i.value)) === 'https://acmetile.com', 'the website gets https://');
    await clickText(page, '.pt-create [role="radio"]', 'Champion');
    await shot(page, 'desk-create', { grow: false });
    await axeCheck(page, 'Add a partner');
    await clickText(page, '.kd-dialog__foot .btn', 'Add partner');
    await page.waitForFunction(() => !document.querySelector('#pt-new-name'), { timeout: 5000 }).catch(() => {});
    const acme = api.st.partners['acme-tile-co'];
    const lastChampOrder = Math.max(...fxSections.champion.map((p) => p.order || 0));
    ok(acme?.level === 'champion' && acme.website === 'https://acmetile.com' && acme.order > lastChampOrder, `Acme saved as the last Champion (order ${acme?.order})`);

    // Delete from the row menu, then bring it back from Recently deleted
    const rm = await rowMenu(page, 'Acme Tile Co.', 'Delete');
    if (process.env.DEBUG) console.log('rowMenu', rm, await page.evaluate(dialogTitle), await $text(page, '.ppl-menu__pop [role=menuitem]'));
    await page.waitForSelector('.pt-del__lead');
    await clickText(page, '.kd-dialog__foot .btn', 'Delete partner');
    await page.waitForFunction(() => ![...document.querySelectorAll('.ppl-row__name')].some((e) => e.textContent.trim() === 'Acme Tile Co.'), { timeout: 5000 }).catch(() => {});
    ok(!api.st.partners['acme-tile-co'], 'deleted');
    await page.evaluate(() => document.querySelector('.ppl-head__actions [aria-haspopup="menu"]')?.click());
    await page.waitForSelector('.ppl-menu__pop', { timeout: 3000 });
    await clickText(page, '.ppl-menu__pop [role="menuitem"]', 'Recently deleted');
    await page.waitForSelector('.kd-deleted li', { timeout: 5000 }).catch(() => {});
    if (process.env.DEBUG) console.log('deleted dlg', await page.evaluate(dialogTitle), await page.evaluate(() => document.querySelector('.kd-dialog__body')?.textContent.slice(0, 200)), api.st.deleted.map((d) => d.slug), api.st.calls.filter((c) => c.path === '/api/content-history').map((c) => c.query));
    ok(/Acme Tile Co\./.test(await page.$eval('.kd-deleted', (e) => e.textContent).catch(() => '')), 'Recently deleted lists it');
    await clickText(page, '.kd-deleted .btn', 'Restore');
    await sleep(800);
    ok(!!api.st.partners['acme-tile-co'], 'Restore brings it back');
    await page.keyboard.press('Escape');
    ok(errors.length === 0, `no console errors on the list${errors.length ? `: ${errors.join(' | ')}` : ''}`);

    // Deleting a Signature partner says they leave the home page strip too
    await rowMenu(page, FX.partners.pella.name, 'Delete');
    await page.waitForSelector('.pt-del__lead');
    ok(/home page logo strip/.test(await page.$eval('.pt-del__lead', (e) => e.textContent)), 'deleting a Signature partner mentions the home page logo strip');
    await clickText(page, '.kd-dialog__foot .btn', 'Cancel');
    await sleep(200);

    // A partner with no category chosen: it stays unchosen until someone picks one
    const nocat = Object.values(api.st.partners).find((p) => PS.withDefaults(p).level === 'friend' && PS.categoryUnset(p) && p.slug !== 'laccurate-lock-hardware');
    await page.evaluate((n) => [...document.querySelectorAll('.ppl-row__name')].find((e) => e.textContent.trim() === n)?.click(), nocat.name);
    await page.waitForSelector('.pt-ed-head');
    await sleep(400);
    ok((await page.$$eval('.pt-cats .pt-cat[aria-checked="true"]', (b) => b.length)) === 0 && /None chosen yet/.test(await page.$eval('.pt-page', (e) => e.textContent)), `${nocat.name}: no category shows as none chosen, not as Build`);
    await typeInto(page, '#pt-web', 'example-partner.com');
    await page.click('.kd-save');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('.kd-bar__save')?.textContent || ''), { timeout: 5000 }).catch(() => {});
    const nc = api.st.partners[nocat.slug];
    ok(nc.website === 'https://example-partner.com' && !('category' in nc) && nc.name === nocat.name, 'saving the website leaves the category unchosen and the rest as it was');
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.pt-row');

    // Two listings that are one partner: Atlanta Kitchen merged into Construction Resources
    await page.evaluate((n) => [...document.querySelectorAll('.ppl-row__name')].find((e) => e.textContent.trim() === n)?.click(), FX.partners['atlanta-kitchen'].name.trim());
    await page.waitForSelector('.pt-same__acts .btn', { timeout: 8000 }).catch(() => {});
    ok(/Merge into Construction Resources/.test(await page.$eval('.pt-same__acts', (e) => e.textContent).catch(() => '')), 'a possible duplicate offers “Merge into” the other');
    await clickText(page, '.pt-same__acts .btn', 'Merge into Construction Resources');
    await page.waitForSelector('.pt-merge-into');
    await shot(page, 'desk-merge-into', { grow: false });
    await axeCheck(page, 'merge dialog');
    const akLogo = FX.partners['atlanta-kitchen'].logo;
    ok(await page.$eval('.pt-merge-into__swap input', (i) => !i.checked).catch(() => false)
      && /Show Construction Resources’ logo on that kid page/.test(await page.$eval('.pt-merge-into__swap', (e) => e.textContent).catch(() => '')),
    'the kid page with the old logo can switch to the one kept, not ticked to start (and “Resources’”, not “Resources’s”)');
    ok(/Kyle’s page shows Atlanta Kitchen’s logo\. It counts for Construction Resources now, and keeps that logo\./.test(await page.$eval('.pt-merge-into', (e) => e.textContent)), 'unticked, the dialog names the kid page and says it keeps its logo');
    const swapsBefore = api.st.calls.filter((c) => c.path === '/api/partners-batch' && c.body?.swapLogo).length;
    await clickText(page, '.kd-dialog__foot .btn', 'Merge into Construction Resources');
    await page.waitForFunction(() => /Construction Resources/.test(document.querySelector('.pt-ed-head h2')?.textContent || ''), { timeout: 8000 }).catch(() => {});
    const crAfter = api.st.partners['construction-resources'];
    ok(!api.st.partners['atlanta-kitchen'] && crAfter.logoFolders?.includes('atlanta-kitchen') && crAfter.level === 'signature', 'merged: Atlanta Kitchen is gone, its logo folder now counts for Construction Resources, which keeps its level');
    ok(api.st.calls.filter((c) => c.path === '/api/partners-batch' && c.body?.swapLogo).length === swapsBefore
      && api.st.kids.kyle.partnerLogos.some((l) => l.url === akLogo), 'left unticked, Kyle’s page keeps the Atlanta Kitchen logo');
    ok(/Construction Resources/.test(await page.$eval('.pt-ed-head h2', (e) => e.textContent).catch(() => '')), 'and the editor opens Construction Resources');
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.pt-row');

    // Angela Means Design into Means & Carney Interiors, ticked: Kyle’s page shows the Means & Carney logo
    const amLogo = FX.partners['angela-means-design'].logo;
    const mcLogo = FX.partners['means-and-carney-interiors'].logo;
    await page.evaluate((n) => [...document.querySelectorAll('.ppl-row__name')].find((e) => e.textContent.trim() === n)?.click(), 'Angela Means Design');
    await page.waitForSelector('.pt-same__acts .btn', { timeout: 8000 }).catch(() => {});
    await clickText(page, '.pt-same__acts .btn', 'Merge into Means & Carney Interiors');
    await page.waitForSelector('.pt-merge-into__swap input', { timeout: 5000 }).catch(() => {});
    await page.click('.pt-merge-into__swap input').catch(() => {});
    await sleep(150);
    ok(/It counts for Means & Carney Interiors now, and shows Means & Carney Interiors’ logo instead\./.test(await page.$eval('.pt-merge-into', (e) => e.textContent).catch(() => '')), 'ticked, the dialog says the kid page shows the kept logo');
    await page.waitForFunction(() => { const i = [...document.querySelectorAll('.pt-merge-into__logos img')]; return i.length === 2 && i.every((x) => x.complete && x.naturalWidth); }, { timeout: 8000 }).catch(() => {});
    ok(await page.$$eval('.pt-merge-into__logos img', (i) => i.length === 2 && i.every((x) => x.naturalWidth > 0)), 'the old and the kept logo both show, side by side');
    await shot(page, 'desk-merge-into-swap', { grow: false });
    await axeCheck(page, 'merge dialog, switching logos');
    await clickText(page, '.kd-dialog__foot .btn', 'Merge into Means & Carney Interiors');
    await page.waitForFunction(() => /Means & Carney/.test(document.querySelector('.pt-ed-head h2')?.textContent || ''), { timeout: 8000 }).catch(() => {});
    const mcSwap = lastCall(api, '/api/partners-batch')?.body.swapLogo;
    ok(mcSwap?.from === amLogo && mcSwap.to === mcLogo && mcSwap.name === 'Means & Carney Interiors', 'one request switches the old logo to the kept one');
    const kyleLogos = api.st.kids.kyle.partnerLogos;
    ok(kyleLogos.some((l) => l.url === mcLogo && l.name === 'Means & Carney Interiors') && !kyleLogos.some((l) => l.url === amLogo) && kyleLogos.some((l) => l.url === akLogo),
      'Kyle’s page shows Means & Carney now, named, and still the Atlanta Kitchen logo');
    const swapAt = api.st.calls.findIndex((c) => c.path === '/api/partners-batch' && c.body?.swapLogo?.from === amLogo);
    const delAt = api.st.calls.findIndex((c, i) => i > swapAt && c.path === '/api/delete-content' && /angela-means-design/.test(JSON.stringify(c.body || c.query || '')));
    ok(!api.st.partners['angela-means-design'] && swapAt >= 0 && delAt > swapAt && api.st.partners['means-and-carney-interiors'].logoFolders?.includes('angela-means-design'),
      'the kid pages switch before Angela Means Design is deleted; its folder counts for Means & Carney');
    ok(/1 kid page now shows its logo/.test(await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' | ')).catch(() => '')), 'the toast says how many kid pages switched');
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.pt-row');

    // ── The editor ──
    await page.evaluate(() => [...document.querySelectorAll('.ppl-row__name')].find((e) => e.textContent.trim() === 'Bell Cabinetry')?.click());
    await page.waitForSelector('.pt-ed-head', { timeout: 8000 });
    await sleep(1200);
    ok(/Signature/.test(await page.$eval('.pt-ed-head', (e) => e.textContent)), 'editor header: level, website, kid pages');
    ok(await page.$('.pt-prev__sig') !== null, 'their Signature card, drawn as the page draws it');
    ok((await page.$$eval('.pt-kids li', (l) => l.length)) === 4, 'four kid pages show their logo');
    const health = await $text(page, '.kd-card--health .kd-checks li');
    ok(health.includes('Write a tagline'), `health asks for a Signature tagline (${health.join(', ')})`);
    await shot(page, 'desk-editor');
    await axeCheck(page, 'editor');

    // Level → Champion: the card and the fields follow; Save puts them last
    await clickText(page, '.pt-level-opt', 'Champion');
    await sleep(150);
    ok(await page.$('.pt-prev__champ') !== null && !(await page.$('#pt-tagline')), 'Champion: the champion card, and no tagline field (champion cards have none)');
    ok(/Unsaved changes/.test(await page.$eval('.kd-bar__save', (e) => e.textContent)), 'the bar says Unsaved changes');
    // A website that isn't one blocks Save
    await typeInto(page, '#pt-web', 'call us');
    await page.click('.kd-save');
    ok(await waitToast(page, /isn’t a web address/), 'a website that isn’t a web address stops Save, with why');
    await typeInto(page, '#pt-web', 'bellcabinetry.com');
    await page.$eval('#pt-web', (i) => i.blur());
    await page.click('.kd-save');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('.kd-bar__save')?.textContent || ''), { timeout: 5000 }).catch(() => {});
    const bell = api.st.partners.bell;
    const champsNow = PS.sections(Object.values(api.st.partners)).champion;
    ok(bell.level === 'champion' && bell.website === 'https://bellcabinetry.com' && champsNow.at(-1)?.slug === 'bell', `saved as the last Champion (order ${bell.order}), website tidied`);
    await clickText(page, '.pt-level-opt', 'Signature');
    await page.click('.kd-save');
    await sleep(600);

    // A new logo: the old file stays; the kid pages showing it can follow
    const oldLogo = api.st.partners.bell.logo;
    const input = await page.$('.pt-logo-stage input[type="file"]');
    await input.uploadFile(UPLOAD);
    await page.waitForFunction(() => /Unsaved/.test(document.querySelector('.kd-bar__save')?.textContent || '') && !document.querySelector('.pt-logo-stage .kd-tile__busy'), { timeout: 6000 }).catch(() => {});
    ok(/The old file is kept/.test(await page.$eval('.pt-logo-stage', (e) => e.textContent)), 'before saving: the old file is kept, 4 kid pages still show it');
    await page.click('.kd-save');
    await page.waitForSelector('.pt-swap', { timeout: 5000 }).catch(() => {});
    ok(/still on 4 kid pages/.test(await page.$eval('.pt-swap', (e) => e.textContent).catch(() => '')), 'after saving: offer to show the new logo on the 4 kid pages');
    ok(api.st.deletedImages.length === 0, 'the old logo file is never deleted');
    await clickText(page, '.pt-swap .btn', 'Update 4');
    await page.waitForFunction(() => !document.querySelector('.pt-swap'), { timeout: 5000 }).catch(() => {});
    const swap = lastCall(api, '/api/partners-batch');
    ok(swap?.body.swapLogo?.from === oldLogo && swap.body.swapLogo.to === api.st.partners.bell.logo, 'one request switches the kid pages from the old logo to the new');
    ok(Object.values(api.st.kids).filter((k) => (k.partnerLogos || []).some((l) => l.url === api.st.partners.bell.logo)).length === 4, 'all 4 kid pages show the new logo');

    // History: compare and restore
    await page.$eval('.kd-card--history .kd-history__all', (b) => b.click());
    await page.waitForSelector('.kd-hist__item', { timeout: 5000 }).catch(() => {});
    if (process.env.DEBUG) console.log('hist', await page.evaluate(dialogTitle), await page.evaluate(() => document.querySelector('.kd-card--history')?.textContent.slice(0, 200)), api.st.calls.filter((c) => c.path === '/api/content-history').map((c) => c.query).slice(-4));
    ok((await page.$$eval('.kd-hist__item', (l) => l.length)) >= 4, 'History lists every save');
    await page.evaluate(() => document.querySelectorAll('.kd-hist__item')[1]?.click());
    await page.waitForFunction(() => /Restoring it changes/.test(document.querySelector('.kd-hist__detail')?.textContent || ''), { timeout: 5000 }).catch(() => {});
    await shot(page, 'desk-history', { grow: false });
    ok(await page.evaluate(() => document.querySelectorAll('.toast').length <= 3), 'no more than three toasts show at once');
    await axeCheck(page, 'history');
    await clickText(page, '.kd-dialog__foot .btn', 'Restore this version');
    await sleep(300);
    ok(/Unsaved changes/.test(await page.$eval('.kd-bar__save', (e) => e.textContent)), 'Restore loads that version into the editor, unsaved');
    await clickText(page, '.kd-bar__save .btn', 'Discard');
    await sleep(200);

    // A save made meanwhile elsewhere: both kept when they don't overlap
    api.st.conflictOnce = { slug: 'bell', patch: { tagline: 'Cabinets for every room since 2016' } };
    await typeInto(page, '#pt-name', 'Bell Cabinetry & Design');
    await page.click('.kd-save');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('.kd-bar__save')?.textContent || ''), { timeout: 6000 }).catch(() => {});
    ok(api.st.partners.bell.name === 'Bell Cabinetry & Design' && api.st.partners.bell.tagline === 'Cabinets for every room since 2016', 'a save made meanwhile is merged: their tagline and your name both kept');
    ok((await page.$eval('#pt-tagline', (i) => i.value)) === 'Cabinets for every room since 2016', 'the editor shows their tagline too');

    // Preview frames the real Partners page with the unsaved name
    await clickText(page, '.kd-ed-actions .btn', 'Preview');
    await typeInto(page, '#pt-name', 'Bell Preview Test');
    let previewOk = false;
    for (let i = 0; i < 40 && !previewOk; i++) {
      await sleep(500);
      previewOk = await page.evaluate(() => [...document.querySelectorAll('iframe')].some((f) => {
        try { return [...f.contentDocument.querySelectorAll('.sig-card__name')].some((t) => t.textContent === 'Bell Preview Test'); } catch { return false; }
      }));
    }
    ok(previewOk, 'Preview shows the unsaved name on the real Partners page');
    await shot(page, 'desk-editor-preview', { grow: false });
    await clickText(page, '.kd-ed-actions .btn', 'Preview');
    await clickText(page, '.kd-bar__save .btn', 'Discard');

    // Wide empty margins: Mohawk's logo, cropped in the editor
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.pt-row');
    await page.evaluate((n) => [...document.querySelectorAll('.ppl-row__name')].find((e) => e.textContent.trim() === n)?.click(), FX.partners.mohawk.name);
    await page.waitForSelector('.pt-margins', { timeout: 10000 }).catch(() => {});
    const mNote = await page.$eval('.pt-margins', (e) => e.textContent).catch(() => '');
    const mExpect = fxMargins(FX.partners.mohawk);
    ok(/Wide empty margins\. On the Signature card it shows [\d.]+× smaller/.test(mNote), `the editor says how much smaller the margins make it (${mNote.slice(0, 80)}; about ${mExpect.toFixed(1)}×)`);
    await page.waitForFunction(() => document.querySelectorAll('.pt-margins .pt-crop__box img').length === 2, { timeout: 8000 }).catch(() => {});
    ok((await page.$$('.pt-margins .pt-crop__box img')).length === 2, 'with the logo now and cropped, side by side');
    await shot(page, 'desk-editor-margins');
    const upBefore = api.st.uploads.length;
    await clickText(page, '.pt-margins .btn', 'Crop the margins');
    await page.waitForFunction(() => /Unsaved/.test(document.querySelector('.kd-bar__save')?.textContent || '') && !document.querySelector('.pt-logo-stage .kd-tile__busy'), { timeout: 10000 }).catch(() => {});
    await sleep(300);
    // (A PNG's bytes don't come back through the browser's request API; an SVG's text does, below)
    ok(api.st.uploads.length === upBefore + 1 && /partners\/uploaded\//.test(await page.$eval('.pt-logo-stage img', (i) => i.src).catch(() => '')), 'Crop the margins uploads a cropped copy and shows it');
    ok(cfCalls.some((c) => /partners\/mohawk\/w=4000,h=4000,fit=scale-down,f=png$/.test(c)), 'the crop starts from a lossless PNG copy of the original');
    const oldMohawk = api.st.partners.mohawk.logo;
    await page.click('.kd-save');
    await page.waitForSelector('.pt-swap', { timeout: 6000 }).catch(() => {});
    ok(api.st.partners.mohawk.logo !== oldMohawk && /still on \d+ kid page/.test(await page.$eval('.pt-swap', (e) => e.textContent).catch(() => '')), 'saved, with the offer to show it on the kid pages that have the old one');
    await clickText(page, '.pt-swap .btn', 'Keep the old one');
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.pt-row');

    // The rest in one go: the crop tool (MSI's SVG stays an SVG, with a new viewBox)
    await page.waitForFunction(() => /Crop logo margins\s*1/.test(document.querySelector('.pt-crop-btn')?.textContent || ''), { timeout: 15000 }).catch(() => {});
    await page.click('.pt-crop-btn');
    await page.waitForSelector('.pt-crop__row');
    ok(JSON.stringify(await $text(page, '.pt-crop__name strong')) === JSON.stringify([FX.partners.msi.name]), 'the crop tool lists what’s left: MSI');
    await page.waitForFunction(() => document.querySelectorAll('.pt-crop__row .pt-crop__box img').length === 2, { timeout: 8000 }).catch(() => {});
    await shot(page, 'desk-crop-tool', { grow: false });
    await axeCheck(page, 'crop tool');
    const msiOld = api.st.partners.msi.logo;
    await clickText(page, '.kd-dialog__foot .btn', 'Crop 1 logo');
    await page.waitForFunction(() => /Done/.test(document.querySelector('.kd-tidy-run__line')?.textContent || ''), { timeout: 15000 }).catch(() => {});
    const svgUp = api.st.uploads.at(-1) || '';
    ok(/image\/svg\+xml/.test(svgUp) && /viewBox="19\d(\.\d+)? 11\d(\.\d+)? 21\d(\.\d+)? 7\d(\.\d+)?"/.test(svgUp), `MSI uploaded as an SVG cropped to its content (${(svgUp.match(/viewBox="[^"]+"/) || [''])[0]})`);
    ok(api.st.partners.msi.logo !== msiOld, 'and saved on the partner');
    const msiKids = (fxUsage.byPartner.get('msi') || []).map((k) => k.slug);
    ok(msiKids.length > 0 && msiKids.every((k) => api.st.kids[k].partnerLogos.some((l) => l.url === api.st.partners.msi.logo)), `its ${msiKids.length} kid pages show the cropped one`);
    ok(api.st.deletedImages.length === 0, 'no old logo file is deleted');
    await clickText(page, '.kd-dialog__foot .btn', 'Done');
    await sleep(300);

    // An older logo on some kid pages: Sherwin Williams
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.pt-row');
    await page.evaluate((n) => [...document.querySelectorAll('.ppl-row__name')].find((e) => e.textContent.trim() === n)?.click(), FX.partners['sherwin-williams-store'].name);
    await page.waitForSelector('.pt-ed-head');
    await sleep(600);
    const older = await page.$eval('.pt-older', (e) => e.textContent).catch(() => '');
    ok(/show an older logo/.test(older), `kid pages with an older logo of theirs are flagged (${older.slice(0, 60)})`);
    await clickText(page, '.pt-older .btn', 'Use the current logo');
    await sleep(800);
    ok(lastCall(api, '/api/partners-batch')?.body.swapLogo?.to === api.st.partners['sherwin-williams-store'].logo, 'Use the current logo switches them');

    // Open a kid page from the partner
    await page.evaluate(() => document.querySelector('.pt-kid')?.click());
    await page.waitForFunction(() => document.querySelector('.nav-item.active')?.textContent.includes('Kids') && !!document.querySelector('.kd-ed-head'), { timeout: 8000 }).catch(() => {});
    ok(await page.evaluate(() => !!document.querySelector('.kd-ed-head')), 'a kid page opens in the Kids editor');
    ok(errors.length === 0, `no console errors in the editor${errors.length ? `: ${errors.join(' | ')}` : ''}`);

    // ── Community partners ──
    await goPartners(page, 'Community partners');
    await page.waitForSelector('.pt-row--cp');
    ok(/Every partner appears there; the logo is optional/.test(await page.$eval('.page-sub', (e) => e.textContent).catch(() => '')) && !(await page.$('.pt-cp-note')), 'Community: every partner is on the page, the logo optional');
    ok(/No logo/.test(await page.$eval('.pt-row--cp .ppl-row__issues', (e) => e.textContent).catch(() => '')), 'a partner without a logo gets a quiet “No logo”, not a warning');
    const cp0 = await $text(page, '.pt-row--cp .ppl-row__name');
    await page.focus('.pt-row--cp .ppl-handle');
    await page.keyboard.press('Space');
    await sleep(150);
    await page.keyboard.press('ArrowDown');
    await sleep(250);
    await page.keyboard.press('Space');
    await sleep(600);
    ok(lastCall(api, '/api/reorder-content')?.body.collection === 'community_partners', 'Community: reorder in one request');
    await shot(page, 'desk-community');
    await axeCheck(page, 'community partners');
    await page.evaluate((n) => [...document.querySelectorAll('.ppl-row__name')].find((e) => e.textContent.trim() === n)?.click(), cp0[0]);
    await page.waitForSelector('#cp-name');
    const cpInput = await page.$('.pt-logo-stage input[type="file"]');
    await cpInput.uploadFile(UPLOAD);
    await page.waitForFunction(() => document.querySelector('.pt-logo-stage img')?.src.includes('/partners/uploaded/'), { timeout: 6000 }).catch(() => {});
    ok(/On the Community page/.test(await page.$eval('.pt-ed-head', (e) => e.textContent)) && /Shown on their card when filled in/.test(await page.$eval('#cp-about-h', (e) => e.parentElement.textContent)), 'the editor says what their card shows, logo or not');
    await typeInto(page, '#cp-web', 'example.org');
    await page.$eval('#cp-web', (i) => i.blur());
    const cpSlug0 = Object.keys(api.st.communityPartners).find((sl) => api.st.communityPartners[sl].name === cp0[0]);
    api.st.conflictOnce = { slug: cpSlug0, patch: { location: 'Decatur, GA' } };
    await page.click('.kd-save');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('.kd-bar__save')?.textContent || ''), { timeout: 5000 }).catch(() => {});
    const cpSlug = Object.keys(api.st.communityPartners).find((s) => api.st.communityPartners[s].name === cp0[0]);
    ok(api.st.communityPartners[cpSlug]?.logo?.includes('/partners/uploaded/') && api.st.communityPartners[cpSlug].website === 'https://example.org', 'Community partner saved with the logo and website');
    ok(api.st.communityPartners[cpSlug]?.location === 'Decatur, GA', 'a save made meanwhile (their location) is kept too');
    await shot(page, 'desk-community-editor');
    await axeCheck(page, 'community partner editor');
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.pt-row--cp');

    // Media logos are outlets now, in Press → Outlets (scripts/test-press-admin.mjs)

    // From anywhere: the command palette adds a partner in its dialog
    const palette = async (q) => {
      await page.keyboard.down('Meta'); await page.keyboard.press('KeyK'); await page.keyboard.up('Meta');
      await page.waitForSelector('.cmd-palette-input');
      await page.type('.cmd-palette-input', q);
      await sleep(150);
      await page.keyboard.press('Enter');
    };
    await palette('Add New Partner');
    await page.waitForSelector('#pt-new-name', { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(dialogTitle) === 'Add a partner' && !!(await page.$('.pt-row')), 'command palette: Add New Partner opens the dialog over the list');
    await page.keyboard.press('Escape');
    await sleep(200);
    ok(!(await page.$('#pt-new-name')), 'Escape closes it');
    ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  // ════════ The staff email's link: #partners?waiting opens Waiting for a logo ════════
  console.log('The missing-logo email’s link');
  {
    const { page, api, errors } = await open(browser, { width: 1280, height: 900, mobile: false, hash: '#partners?waiting' });
    await page.waitForSelector('.pt-wait .pt-loose__item', { timeout: 15000 }).catch(() => {});
    ok(await page.evaluate(dialogTitle) === 'Waiting for a logo', 'opening the admin from the email’s link shows Waiting for a logo');
    ok(await page.evaluate(() => location.hash) === '#partners', `and the address is tidied to Partners (${await page.evaluate(() => location.hash)})`);
    await page.keyboard.press('Escape');
    await sleep(300);
    const labelRows = await page.$$eval('.ppl-ready__label', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    ok(new Set(labelRows).size === 1, `at 1280 every tile label keeps to one line (${labelRows.join(', ')})`);
    const rows1280 = await page.$$eval('.ppl-ready__tile', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    ok(rows1280.slice(0, 3).every((t) => t === rows1280[0]) && rows1280[3] === rows1280[4] && rows1280[3] > rows1280[0], `at 1280: the three checks, then the two lists (${rows1280.join(', ')})`);
    await shot(page, 'desk1280-tiles', { grow: false });
    await page.evaluate(() => { location.hash = '#partners?waiting'; });
    await page.waitForSelector('.pt-wait', { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(dialogTitle) === 'Waiting for a logo', 'following the link with the admin already open does too');
    ok(await page.evaluate(() => location.hash) === '#partners', 'and tidies the address, so the next click on it works too');
    const tileTops = await page.$$eval('.ppl-ready__tile', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    ok(tileTops.length === 5, `five readiness tiles (${tileTops.length})`);
    // A company already in Partners without a logo: the button opens that partner, there's nothing to link
    api.st.logos.waiting.push({ ...api.st.logos.waiting[0], company: 'carlossandyramirez', name: 'Carlos & Sandy Ramirez', hint: 'Carlos & Sandy Ramirez is in Partners without a logo' });
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.evaluate(() => { location.hash = '#partners?waiting'; });
    await page.waitForFunction(() => [...document.querySelectorAll('.pt-wait strong')].some((e) => e.textContent === 'Carlos & Sandy Ramirez'), { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(() => [...document.querySelectorAll('.pt-wait strong')].some((e) => e.textContent === 'Carlos & Sandy Ramirez')), 'following the link reads the list again (one added since the admin opened shows)');
    const noLogoActs = await page.evaluate(() => [...document.querySelectorAll('.pt-wait .pt-loose__item')].find((li) => li.querySelector('strong')?.textContent === 'Carlos & Sandy Ramirez')?.querySelector('.pt-loose__acts')?.textContent.replace(/\s+/g, ' ').trim() || '');
    ok(/^Add a logo to Carlos & Sandy Ramirez/.test(noLogoActs) && !/Same as|Add to Partners/.test(noLogoActs), `listed without a logo: “Add a logo to …”, no duplicate offered (${noLogoActs.slice(0, 70)})`);
    await clickText(page, '.pt-wait .btn', 'Add a logo to Carlos');
    await page.waitForSelector('.pt-ed-head', { timeout: 5000 }).catch(() => {});
    ok(/Carlos & Sandy Ramirez/.test(await page.$eval('.pt-ed-head', (e) => e.textContent).catch(() => '')), 'and opens that partner to add it');
    await page.evaluate(() => { location.hash = '#partners'; });
    await sleep(400);
    await page.keyboard.press('Escape');
    await sleep(200);

    // Isla's page in the admin: what's still needed from JobTread, and an upload named for the company
    await page.evaluate(() => { location.hash = '#kids/isla'; });
    await page.waitForSelector('.kd-logowait', { timeout: 15000 }).catch(() => {});
    const strip = await page.$eval('.kd-logowait', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
    ok(/3 logos still needed/.test(strip) && /Kind Neighbors Fund/.test(strip) && /Sponsor · Nia Nguyen · nia@kindneighbors\.example/.test(strip), `Isla’s Partners section lists the logos still needed, with who to ask (${strip.slice(0, 120)})`);
    await page.$eval('.kd-logowait', (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
    await shot(page, 'kid-logowait', { grow: false });
    const logoFile = join(OUT, 'jobtread-logo.png');
    writeFileSync(logoFile, PNG_LOGO);
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), clickText(page, '.kd-logowait li .btn', 'Upload their logo')]);
    await chooser.accept([logoFile]);
    await page.waitForFunction(() => [...document.querySelectorAll('.kd-logos input[aria-label^="Company name"]')].some((i) => i.value === 'Kind Neighbors Fund'), { timeout: 8000 }).catch(() => {});
    const names = await page.$$eval('.kd-logos input[aria-label^="Company name"]', (els) => els.map((i) => i.value));
    ok(names.at(-1) === 'Kind Neighbors Fund', `the upload is named for the company, so the site knows it’s theirs (${names.at(-1)})`);
    ok(!/Kind Neighbors Fund/.test(await page.$eval('.kd-logowait', (e) => e.textContent).catch(() => '')), 'and it leaves the strip');
    ok(errors.length === 0, `no console errors from the link${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  // ════════ The email's link on a phone: the list, then the kid's page ════════
  console.log('Phone 390: the missing-logo email’s link');
  {
    const { page, errors } = await open(browser, { width: 390, height: 844, mobile: true, hash: '#partners?waiting' });
    await page.waitForSelector('.pt-wait .pt-loose__item', { timeout: 15000 }).catch(() => {});
    ok(await page.evaluate(dialogTitle) === 'Waiting for a logo', 'phone: the email’s link opens the list');
    const fit = await page.evaluate(() => {
      const d = document.querySelector('.kd-dialog');
      const r = d?.getBoundingClientRect();
      const wide = [...(d?.querySelectorAll('*') || [])].filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.left < -0.5 || b.right > innerWidth + 0.5); }).map((el) => `${el.tagName}.${String(el.className).slice(0, 30)}`);
      return { ok: !!r && r.left >= 0 && r.right <= innerWidth, wide: wide.slice(0, 4) };
    });
    ok(fit.ok && !fit.wide.length, `phone: the list fits the screen${fit.wide.length ? ` (${fit.wide.join(', ')})` : ''}`);
    const smallTargets = await page.evaluate(() => [...document.querySelectorAll('.pt-wait .btn, .pt-wait select, .pt-wait__emails .btn, .pt-wait__emails input')]
      .filter((el) => el.getBoundingClientRect().height < 44).map((el) => (el.textContent || el.tagName).trim().slice(0, 24)).slice(0, 4));
    ok(!smallTargets.length, `phone: every button in the list is a 44px target${smallTargets.length ? ` (${smallTargets.join(', ')})` : ''}`);
    const emailFont = await page.$eval('#pt-wait-emails', (i) => parseFloat(getComputedStyle(i).fontSize)).catch(() => 0);
    ok(emailFont >= 16, `phone: the email field is 16px, so iPhone doesn’t zoom into it (${emailFont}px)`);
    await shot(page, 'phone-waiting', { grow: false });
    await axeCheck(page, 'phone waiting for a logo');
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.evaluate(() => { location.hash = '#kids/isla'; });
    await page.waitForSelector('.kd-logowait', { timeout: 15000 }).catch(() => {});
    await page.$eval('.kd-logowait', (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
    const strip = await page.evaluate(() => {
      const w = document.querySelector('.kd-logowait');
      const r = w?.getBoundingClientRect();
      const btns = [...(w?.querySelectorAll('.btn') || [])].map((b) => b.getBoundingClientRect());
      return { ok: !!r && r.left >= 0 && r.right <= innerWidth, small: btns.filter((b) => b.height < 44).length, n: btns.length };
    });
    ok(strip.ok && strip.n === 2 && !strip.small, `phone: Isla’s “logos still needed” fits, with 44px upload buttons (${strip.n} buttons, ${strip.small} small)`);
    await shot(page, 'phone-kid-logowait', { grow: false });
    ok(errors.length === 0, `no console errors on the phone link${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  // ════════ Offline: a dropped connection is never a missing logo ════════
  console.log('Offline');
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(() => {
      window.__offline = false;
      Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get() { return !window.__offline; } });
    });
    const api = makeApi();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.isInterceptResolutionHandled()) return;
      if (new URL(req.url()).origin === SITE && api.respond(req) !== false) return;
      if (cfRespond(req) !== false) return;
      req.continue();
    });
    await page.goto(`${SITE}/admin/index.html`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.nav-item');
    OFFLINE = true;
    await page.evaluate(() => { window.__offline = true; window.dispatchEvent(new Event('offline')); });
    await goPartners(page);
    await page.waitForFunction(() => !document.querySelector('.ppl-ready__tile .spinner'), { timeout: 20000 }).catch(() => {});
    const t0 = (await $text(page, '.ppl-ready__tile'))[0];
    ok(/not checked \(offline\)/.test(t0), `offline: the Logos tile says they couldn’t be checked (${t0})`);
    ok(!(await page.evaluate(() => [...document.querySelectorAll('.ppl-chip')].some((c) => /Logo missing/.test(c.textContent)))), 'offline: no logo is called missing');
    OFFLINE = false;
    await page.evaluate(() => { window.__offline = false; window.dispatchEvent(new Event('online')); });
    await page.waitForFunction(() => [...document.querySelectorAll('.ppl-chip')].some((c) => /Logo missing/.test(c.textContent)), { timeout: 15000 }).catch(() => {});
    const t1 = (await $text(page, '.ppl-ready__tile'))[0];
    ok(!/offline/.test(t1) && await page.evaluate(() => [...document.querySelectorAll('.ppl-chip')].some((c) => /Logo missing/.test(c.textContent))), `back online, they’re checked again: the one that’s really gone says so (${t1})`);
    await page.close();
  }

  // ════════ iPad (820) ════════
  console.log('iPad 820');
  {
    const before = cfCalls.length;
    const { page, errors } = await open(browser, { width: 820, height: 1180, mobile: true });
    await goPartners(page, null, true);
    await sleep(800);
    await page.waitForFunction(() => !/hecking/.test(document.querySelector('.ppl-ready__tile')?.textContent || ''), { timeout: 20000 }).catch(() => {});
    const measuredAgain = cfCalls.slice(before).filter((c) => /w=240,h=240,fit=scale-down|\/f=json$/.test(c));
    ok(measuredAgain.length === 0, `a later visit measures nothing again: sizes and margins are kept in the browser (${measuredAgain.length} asked)`);
    const over = await overflow(page);
    ok(!over.length, `iPad list: nothing past the content column${over.length ? ` (${over.join(', ')})` : ''}`);
    await shot(page, 'ipad-list');
    await page.evaluate(() => document.querySelector('.ppl-row__name')?.click());
    await page.waitForSelector('.pt-ed-head');
    await sleep(800);
    const over2 = await overflow(page);
    ok(!over2.length, `iPad editor: nothing past the content column${over2.length ? ` (${over2.join(', ')})` : ''}`);
    await shot(page, 'ipad-editor');
    ok(errors.length === 0, `no console errors on iPad${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }

  // ════════ Phone (390) ════════
  console.log('Phone 390');
  {
    const { page, api, errors } = await open(browser, { width: 390, height: 844, mobile: true });
    await goPartners(page, null, true);
    await sleep(800);
    const over = await overflow(page);
    ok(!over.length, `phone list: nothing past the content column${over.length ? ` (${over.join(', ')})` : ''}`);
    ok(!(await page.$('.pt-row .pt-check')), 'phone: no checkboxes until Select');
    const small = await page.evaluate(() => [...document.querySelectorAll('.pt-row .ppl-handle, .pt-row .ppl-menu__btn, .ppl-filter, .pt-select-btn, .pt-view button')]
      .filter((el) => el.getBoundingClientRect().height < 44 || el.getBoundingClientRect().width < 40).map((el) => el.className).slice(0, 4));
    ok(!small.length, `phone: 44px targets${small.length ? ` (${small.join(', ')})` : ''}`);
    await shot(page, 'phone-list');
    await axeCheck(page, 'phone list');
    await clickText(page, '.pt-select-btn', 'Select');
    await sleep(200);
    ok((await page.$$('.pt-row .pt-check')).length > 0 && !(await page.$('.pt-row .ppl-handle')), 'Select: checkboxes take the handles’ place');
    await page.evaluate(() => document.querySelector('.pt-row .pt-check')?.click());
    await page.waitForSelector('.pt-selectbar');
    const over2 = await overflow(page);
    ok(!over2.length, `phone selection bar fits${over2.length ? ` (${over2.join(', ')})` : ''}`);
    await shot(page, 'phone-selected', { grow: false });
    await clickText(page, '.pt-selectbar button', 'Clear');
    await sleep(200);
    ok(!(await page.$('.pt-row .pt-check')), 'Clear leaves Select mode');
    // Row menu stays on screen
    await page.evaluate(() => document.querySelector('.pt-section--champion .ppl-menu__btn')?.click());
    await page.waitForSelector('.ppl-menu__pop');
    const pop = await page.$eval('.ppl-menu__pop', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom }; });
    ok(pop.l >= 0 && pop.r <= 390 && pop.b <= 844, 'phone: the row menu stays on screen');
    await page.keyboard.press('Escape');
    // Editor
    await page.evaluate(() => document.querySelector('.pt-section--signature .ppl-row__name')?.click());
    await page.waitForSelector('.pt-ed-head');
    await sleep(1000);
    const over3 = await overflow(page);
    ok(!over3.length, `phone editor: nothing past the content column${over3.length ? ` (${over3.join(', ')})` : ''}`);
    await shot(page, 'phone-editor');
    await axeCheck(page, 'phone editor');
    // Add dialog fits as a sheet
    await page.evaluate(() => document.querySelector('.breadcrumb button')?.click());
    await page.waitForSelector('.pt-row');
    await clickText(page, '.ppl-head__actions .btn', 'Add a partner');
    await page.waitForSelector('#pt-new-name');
    const sheet = await page.$eval('.kd-dialog', (e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= 390; });
    ok(sheet, 'phone: Add a partner fits the screen');
    await shot(page, 'phone-create', { grow: false });
    await page.keyboard.press('Escape');
    // Community partners
    await clickText(page, '.hub-tab', 'Community partners');
    await page.waitForSelector('.pt-row--cp');
    const over4 = await overflow(page);
    ok(!over4.length, `phone community: nothing past the content column${over4.length ? ` (${over4.join(', ')})` : ''}`);
    await shot(page, 'phone-community');
    ok(callsTo(api, '/api/delete-image') === 0, 'nothing deletes a logo file');
    ok(errors.length === 0, `no console errors on the phone${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }
} catch (e) {
  failures.push(`crashed: ${e.stack || e.message}`);
  console.log(e);
} finally {
  await browser.close();
  stopDev();
}
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll partners admin checks passed.');
process.exit(failures.length ? 1 : 0);
